import { randomUUID } from "node:crypto"
import * as path from "node:path"
import fs from "fs/promises"
import { DiagnosticDomain, DiagnosticOutcome } from "@/services/telemetry/instrumentation/diagnostic-events"
import { recordDiagnostic } from "@/services/telemetry/instrumentation/diagnostic-recorder"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { Logger } from "@/shared/services/Logger"

/**
 * Structure of the .lck lock file.
 * Written as JSON to a file adjacent to the protected JSONL file.
 */
interface LockPayload {
    /** Process ID that owns the lock */
    pid: number
    /** Unique acquisition identity, including between lock instances in one process. */
    ownerId?: string
    /** Timestamp when the lease started (ms since epoch). */
    ts: number
    /** Lease length declared by the owner. Absent on locks written before leases existed. */
    ttlMs?: number
}

/**
 * Default lease length for a lock (10 seconds).
 *
 * The owner writes this into the lock file, and the same value interprets locks
 * written before the lease field existed. A lock only becomes a takeover
 * candidate once its *declared* lease has expired: the file modification time is
 * not the authority, because synchronisation, backup and indexing tools rewrite
 * it without the owner knowing.
 */
const STALE_LOCK_TIMEOUT_MS = 10_000

/**
 * How long an unreadable lock file may stay unreadable before it counts as abandoned.
 *
 * The file is created exclusively and then written, so a live owner's lock is
 * briefly empty. Taking it over inside that window would hand the resource to
 * two owners, so only a file that is still unreadable after this grace is
 * treated as leftover garbage from a failed create or a crashed writer.
 */
const UNREADABLE_LOCK_GRACE_MS = 5_000

/**
 * Maximum number of acquire retries when lock is held by another active process.
 * Each retry waits 100ms, giving a total timeout of ~1 second.
 */
const MAX_ACQUIRE_RETRIES = 10
const ACQUIRE_RETRY_DELAY_MS = 100
/**
 * How an acquire ended.
 *
 * `timeout` means the bounded retry was exhausted while another owner held the
 * lock; `error` means the filesystem itself refused the operation. They are
 * kept apart because contention and a faulty path call for different fixes.
 */
type FileLockAcquireOutcome = "acquired" | "timeout" | "error"

const MAX_RELEASE_ATTEMPTS = 5
const RELEASE_RETRY_DELAYS_MS = [10, 25, 50, 100] as const
const RETRYABLE_RELEASE_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"])

/**
 * Derive the lock file path from a JSONL file path.
 * Lock file is `<jsonl_path>.lck`.
 */
function lockPathFor(jsonlPath: string): string {
    return `${jsonlPath}.lck`
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

/**
 * What a lock file currently says about its own lease.
 *
 * `expired` and `unreadable` are takeover candidates; `active` and `missing`
 * are not. `raw` and `mtimeMs` are kept so a takeover can prove it is still
 * acting on the snapshot it judged instead of a lock another owner just wrote.
 */
type LeaseSnapshot =
    | { readonly kind: "missing" }
    | { readonly kind: "active" }
    | { readonly kind: "expired"; readonly raw: string; readonly mtimeMs: number; readonly pid: number; readonly ageMs: number }
    | { readonly kind: "unreadable"; readonly raw: string; readonly mtimeMs: number; readonly ageMs: number }

function declaredLeaseMs(payload: LockPayload): number {
    const ttl = payload.ttlMs
    // Locks written before leases existed carry no ttl; the default interprets them.
    return typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : STALE_LOCK_TIMEOUT_MS
}

/**
 * Read the lease a lock file declares.
 *
 * A readable lease expires by its own declared start and length, not by the file
 * modification time, because external tooling rewrites mtime without the owner
 * knowing. An unreadable file is the `open`-then-`write` window or the leftover
 * of a failed create, so it only becomes a candidate after the write grace.
 */
async function readLease(lockPath: string): Promise<LeaseSnapshot> {
    let mtimeMs: number
    try {
        mtimeMs = (await fs.stat(lockPath)).mtimeMs
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
        // A stat we were not allowed to make says nothing about the owner; treat
        // it as held so a transient permission problem cannot destroy a live lock.
        return { kind: "active" }
    }

    let raw: string
    try {
        raw = await fs.readFile(lockPath, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
        return { kind: "active" }
    }

    let payload: LockPayload
    try {
        payload = JSON.parse(raw) as LockPayload
        if (typeof payload !== "object" || payload === null) throw new Error("Lock payload is not an object")
    } catch {
        const ageMs = Date.now() - mtimeMs
        return ageMs < UNREADABLE_LOCK_GRACE_MS ? { kind: "active" } : { kind: "unreadable", raw, mtimeMs, ageMs }
    }

    const startedAt = typeof payload.ts === "number" && Number.isFinite(payload.ts) ? payload.ts : mtimeMs
    const ageMs = Date.now() - startedAt
    if (ageMs < declaredLeaseMs(payload)) return { kind: "active" }
    // An expired lease still belongs to a live owner: it may be a suspended or
    // slow writer, so only a dead process (or a payload without owner identity)
    // makes the lease a takeover candidate.
    if (typeof payload.ownerId === "string" && payload.ownerId.length > 0 && isProcessAlive(payload.pid)) {
        return { kind: "active" }
    }
    return { kind: "expired", raw, mtimeMs, pid: payload.pid, ageMs }
}

/**
 * Remove a takeover candidate after proving the file is still the same snapshot.
 *
 * Two owners that both decide a lock is stale would otherwise both delete, and
 * the second delete could remove the lock the first just created. Re-reading
 * before `unlink` narrows that window to the file system's own atomicity.
 *
 * @returns `taken` when this caller removed the candidate, `changed` when the
 * lock was rewritten or removed by another owner and must be re-evaluated.
 */
async function takeOverLease(lockPath: string, judged: LeaseSnapshot): Promise<"taken" | "changed"> {
    if (judged.kind !== "expired" && judged.kind !== "unreadable") return "changed"
    const current = await readLease(lockPath)
    // A lock that became `missing` or `active` is no longer the candidate judged
    // above, so only the same unreadable/expired shape may be removed.
    if (current.kind !== judged.kind) return "changed"
    if (current.raw !== judged.raw || current.mtimeMs !== judged.mtimeMs) return "changed"

    if (judged.kind === "unreadable") {
        // A file still unreadable past the write grace has no writer left; it is
        // leftover garbage, not a lock this process failed to parse.
        recordDiagnostic(DiagnosticDomain.Storage, "stale_lock_broken", DiagnosticOutcome.Recovered, { readable: false })
        Logger.warn(`[FileLock] Breaking stale/corrupted lock: path=${lockPath}, age=${Math.round(judged.ageMs)}ms`)
    } else {
        // The age is the diagnostic value: a lock broken far past its lease
        // points at a crashed or suspended owner rather than slow contention.
        recordDiagnostic(DiagnosticDomain.Storage, "stale_lock_broken", DiagnosticOutcome.Recovered, {
            ageMs: judged.ageMs,
            readable: true,
        })
        Logger.warn(`[FileLock] Breaking stale lock: path=${lockPath}, ownerPid=${judged.pid}, age=${Math.round(judged.ageMs)}ms`)
    }

    try {
        await fs.unlink(lockPath)
        return "taken"
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // Another owner already removed it; the next create decides ownership.
        if (code === "ENOENT") return "taken"
        // A delete the file system refused is not contention, and retrying the
        // same rejected delete in a tight loop would only burn the attempt budget.
        throw new Error(`[FileLock] Failed to break stale lock: ${lockPath}`, { cause: error })
    }
}

/**
 * Low-level filesystem lock using a .lck file adjacent to a JSONL file.
 *
 * Inspired by the task history lock in disk.ts, but generalised for
 * any JSONL-backed store.  Guarantees that at most one Node.js process
 * (or VSCode window) holds the lock at any given time.
 *
 * Usage:
 *   const lock = new FileLock()
 *   await lock.withLock(jsonlPath, async () => {
 *       await appendJsonl(jsonlPath, item)
 *   })
 */
export interface FileLockOptions {
    /**
     * Attempts, 100 ms apart, before an acquire gives up on a lock held by an active owner.
     * Defaults to 10, about one second.
     */
    readonly maxAcquireAttempts?: number
}

export class FileLock {
    private readonly ownedLocks = new Map<string, string>()
    private readonly maxAcquireAttempts: number

    constructor(options: FileLockOptions = {}) {
        this.maxAcquireAttempts = options.maxAcquireAttempts ?? MAX_ACQUIRE_RETRIES
    }

    /** Wait without creating or repairing a lock; read consumers must not mutate the protected resource. */
    static async waitUntilUnlocked(filePath: string): Promise<void> {
        const lockPath = lockPathFor(filePath)
        for (let attempt = 1; attempt <= MAX_ACQUIRE_RETRIES; attempt++) {
            try {
                await fs.access(lockPath)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return
                throw error
            }
            if (attempt === MAX_ACQUIRE_RETRIES) throw new Error("Resource transition is still locked")
            await new Promise<void>((resolve) => setTimeout(resolve, ACQUIRE_RETRY_DELAY_MS))
        }
    }

    /**
     * Acquire the lock for a JSONL file.
     *
     * Blocks (with bounded retry) if another active process holds the lock.
     * Breaks stale locks (older than 10s) automatically.
     *
     * @param jsonlPath Absolute path to the protected JSONL file
     * @throws If unable to acquire the lock after MAX_ACQUIRE_RETRIES
     */
    async acquire(jsonlPath: string): Promise<void> {
        const lockPath = lockPathFor(jsonlPath)
        const ownerId = randomUUID()
        const startedAt = performance.now()
        // Every exit reports, not just the successful one. Reporting only on
        // success dropped exactly the samples worth seeing: an acquire that
        // exhausts its retries has waited the longest and is the one that
        // fails a write, so omitting it made the distribution look healthiest
        // precisely when contention was worst.
        const report = (outcome: FileLockAcquireOutcome, durationMs: number): void => {
            recordPerfPhase(PerfDomain.FileLock, "acquire", durationMs, { outcome, retried: attempt > 1 })
        }
        let attempt = 1

        for (; attempt <= this.maxAcquireAttempts; attempt++) {
            const payload: LockPayload = {
                pid: process.pid,
                ownerId,
                ts: Date.now(),
                ttlMs: STALE_LOCK_TIMEOUT_MS,
            }

            try {
                // `wx` is an atomic create-if-absent operation. Unlike stat + writeFile,
                // it cannot let two windows or two lock instances both become owners.
                const openStartedAt = performance.now()
                const handle = await fs.open(lockPath, "wx")
                const openedAt = performance.now()
                let writtenAt = openedAt
                let closedAt = openedAt
                try {
                    try {
                        await handle.writeFile(JSON.stringify(payload), "utf8")
                        writtenAt = performance.now()
                    } finally {
                        await handle.close()
                        closedAt = performance.now()
                    }
                } catch (error) {
                    // This process created the file and then failed to fill it. Leaving the
                    // empty file behind is exactly what made the next owner report a
                    // corrupted lock, so the cleanup belongs to the create that failed.
                    await fs.unlink(lockPath).catch(() => undefined)
                    throw error
                }
                this.ownedLocks.set(jsonlPath, ownerId)
                // Bounded retry caps contention at roughly one second, so a longer
                // acquire on the first attempt means the filesystem call itself was
                // slow rather than the lock being held elsewhere.
                const durationMs = Math.round(performance.now() - startedAt)
                // Telemetry receives every sample so the distribution stays intact; the
                // 250 ms gate only decides whether a human-readable line is worth writing.
                //
                // Only bounded dimensions are reported. This runs at roughly 17/s, so
                // an unbounded value here multiplies faster than anywhere else in the
                // codebase. The attempt count and the three sub-durations would each
                // become their own Prometheus label, and the lock file name is not
                // bounded either: profile-scoped locks embed a profile identity in
                // the file name, so reporting it would grow with the number of
                // profiles and leak that identity into metrics. The detail stays in
                // the debug line below, which is not exported.
                //
                // `retried` rather than `contended`: a retry also happens after a
                // stale lock is broken, which is not contention.
                report("acquired", durationMs)
                if (durationMs >= 250 && Logger.isDebugEnabled()) {
                    Logger.debug(
                        `[FileLockPerf] phase=acquire path=${path.basename(lockPath)} attempts=${attempt} openMs=${Math.round(openedAt - openStartedAt)} writeMs=${Math.round(writtenAt - openedAt)} closeMs=${Math.round(closedAt - writtenAt)} durationMs=${durationMs}`,
                    )
                }
                return
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                    // A filesystem fault, not contention. It is reported apart
                    // from a timeout because the two call for different fixes.
                    report("error", Math.round(performance.now() - startedAt))
                    throw error
                }
            }

            const lease = await readLease(lockPath)
            // `missing` means the owner released it between the failed create and this read.
            if (lease.kind === "missing") continue
            if (lease.kind === "expired" || lease.kind === "unreadable") {
                // A takeover attempt that lost the race falls through to the bounded
                // wait instead of spinning: another owner is already deciding.
                if ((await takeOverLease(lockPath, lease)) === "taken") continue
            }
            if (attempt === this.maxAcquireAttempts) {
                report("timeout", Math.round(performance.now() - startedAt))
                throw new Error(`[FileLock] Failed to acquire lock after ${this.maxAcquireAttempts} attempts: ${lockPath}`)
            }
            await new Promise((r) => setTimeout(r, ACQUIRE_RETRY_DELAY_MS))
        }

        // Reachable only when every attempt broke a stale lock and none
        // succeeded, which is still a caller-visible acquire failure.
        report("timeout", Math.round(performance.now() - startedAt))
        throw new Error(`[FileLock] Failed to acquire lock after all retries: ${lockPath}`)
    }

    /**
     * Release the lock for a JSONL file.
     * Safe to call if this instance never acquired the lock. Transient Windows
     * unlink failures are retried; a persistent owned-lock failure is surfaced.
     *
     * @param jsonlPath Absolute path to the protected JSONL file
     */
    async release(jsonlPath: string): Promise<void> {
        const ownerId = this.ownedLocks.get(jsonlPath)
        if (!ownerId) return
        const lockPath = lockPathFor(jsonlPath)
        let payload: LockPayload
        try {
            payload = JSON.parse(await fs.readFile(lockPath, "utf8")) as LockPayload
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                this.ownedLocks.delete(jsonlPath)
            }
            return
        }
        if (payload.ownerId !== ownerId) {
            this.ownedLocks.delete(jsonlPath)
            return
        }

        for (let attempt = 1; attempt <= MAX_RELEASE_ATTEMPTS; attempt++) {
            try {
                await fs.unlink(lockPath)
                this.ownedLocks.delete(jsonlPath)
                return
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                if (code === "ENOENT") {
                    this.ownedLocks.delete(jsonlPath)
                    return
                }
                if (!code || !RETRYABLE_RELEASE_ERROR_CODES.has(code) || attempt === MAX_RELEASE_ATTEMPTS) {
                    throw new Error(`[FileLock] Failed to release owned lock: ${lockPath}`, { cause: error })
                }
                await new Promise<void>((resolve) => setTimeout(resolve, RELEASE_RETRY_DELAYS_MS[attempt - 1] ?? 0))
            }
        }
    }

    /**
     * Execute a function while holding the file lock.
     * The lock is released even if the function throws.
     *
     * @param jsonlPath Absolute path to the protected JSONL file
     * @param fn The guarded function to execute
     * @returns The return value of fn
     */
    async withLock<T>(jsonlPath: string, fn: () => Promise<T>): Promise<T> {
        await this.acquire(jsonlPath)
        try {
            return await fn()
        } finally {
            await this.release(jsonlPath)
        }
    }
}
