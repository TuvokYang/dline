import fs from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import {
    advanceUsagePolicy,
    parseServerStop,
    parseUsagePolicyDecision,
    resolveUsagePolicy,
    type ServerStop,
    stopUsagePolicy,
    type UsagePolicyDecision,
    type UsagePolicyInputs,
    type UsagePolicyRecord,
} from "@/services/telemetry/remote/policy/usagePolicy"
import { FileLock } from "../backend/jsonl/FileLock"
import type { OtelStorageLayout } from "./OtelStorageLayout"
import { type QuarantineObserver, quarantineDocument } from "./quarantine"

export const REMOTE_POLICY_SCHEMA_VERSION = 1
const LOCK_ACQUIRE_ATTEMPTS = 50
const KNOWN_DOCUMENT_KEYS = new Set(["schema_version", "usage", "server_stop"])

/** The machine-wide remote telemetry policy every window consults before it claims, sends or acknowledges work. */
export interface RemotePolicyState {
    readonly usage?: UsagePolicyRecord
    /** A refusal from the service, held until the user changes consent or resets the identity. */
    readonly serverStop?: ServerStop
}

/** Everything the policy depends on except the server refusal, which the repository owns. */
export type LocalUsagePolicyInputs = Omit<UsagePolicyInputs, "serverStop">

export interface RemotePolicyRepositoryOptions {
    readonly clock?: () => number
    /** Told when an unreadable policy, for example one another Dline build wrote, was moved aside. */
    readonly onQuarantine?: QuarantineObserver
}

type LatestPolicy =
    | { readonly status: "valid"; readonly state: RemotePolicyState; readonly raw: Record<string, unknown> }
    | { readonly status: "missing" }
    | { readonly status: "unsupported" }

/**
 * Owner of `telemetry/remote/policy.json`.
 *
 * Each decision carries an epoch that rises on every change, so a window that
 * started a batch under an older decision recognises itself as stale before it
 * sends or acknowledges. Every reader treats a missing, unreadable or newer
 * document as "remote off", which keeps the failure mode closed.
 */
export class RemotePolicyRepository {
    private readonly lock = new FileLock({ maxAcquireAttempts: LOCK_ACQUIRE_ATTEMPTS })
    private readonly clock: () => number
    private readonly onQuarantine: QuarantineObserver | undefined

    constructor(
        private readonly layout: OtelStorageLayout,
        options: RemotePolicyRepositoryOptions = {},
    ) {
        this.clock = options.clock ?? Date.now
        this.onQuarantine = options.onQuarantine
    }

    /** Lock-free read; `undefined` means no usable policy, which callers must treat as remote off. */
    async read(): Promise<RemotePolicyState | undefined> {
        const latest = await this.readParsed()
        return latest.status === "valid" ? latest.state : undefined
    }

    /**
     * Resolve the usage decision against the latest stored server refusal and
     * persist it. Resolving inside the lock keeps a window with a stale view
     * from re-enabling delivery that another window just stopped.
     *
     * Returns `undefined` when a newer Dline owns the document; delivery stays off.
     */
    async resolveUsage(inputs: LocalUsagePolicyInputs): Promise<UsagePolicyRecord | undefined> {
        return this.mutate((state) => {
            const decision = resolveUsagePolicy({ ...inputs, serverStop: state.serverStop })
            return { ...state, usage: this.nextRecord(state.usage, decision) }
        })
    }

    /** Persist a refusal from the service and turn usage delivery off in the same write. */
    async recordServerStop(stop: ServerStop): Promise<UsagePolicyRecord | undefined> {
        return this.mutate((state) => ({
            serverStop: stop,
            usage: state.usage
                ? stopUsagePolicy(state.usage)
                : this.nextRecord(undefined, { allowed: false, reason: "server_stopped" }),
        }))
    }

    /**
     * Forget a refusal after the user changed consent or reset the identity. The
     * decision stays as it is until the next {@link resolveUsage}, so clearing a
     * stop can never enable delivery by itself.
     */
    async clearServerStop(): Promise<void> {
        await this.mutate((state) => (state.usage ? { usage: state.usage } : {}))
    }

    private nextRecord(previous: UsagePolicyRecord | undefined, decision: UsagePolicyDecision): UsagePolicyRecord {
        if (previous) return advanceUsagePolicy(previous, decision)
        // No readable predecessor (first run, quarantine or deletion): seed from the clock so the
        // epoch never repeats one that an in-flight batch from before may still carry.
        return { epoch: Math.max(1, this.clock()), decision }
    }

    private async mutate(change: (state: RemotePolicyState) => RemotePolicyState): Promise<UsagePolicyRecord | undefined> {
        await fs.mkdir(this.layout.remoteDir, { recursive: true })
        return this.lock.withLock(this.layout.policyPath, async () => {
            const latest = await this.readLatestForWrite()
            if (latest.status === "unsupported") return undefined
            const previous = latest.status === "valid" ? latest.state : {}
            const next = change(previous)
            if (!sameState(previous, next)) {
                const raw = latest.status === "valid" ? latest.raw : {}
                await writeJsonAtomic(
                    this.layout.policyPath,
                    { ...preserveUnknownFields(raw), ...serialize(next) },
                    { fsync: true },
                )
            }
            return next.usage
        })
    }

    private async readLatestForWrite(): Promise<LatestPolicy> {
        const parsed = await this.readParsed()
        if (parsed.status !== "malformed") return parsed
        if (await quarantineDocument(this.layout.policyPath, this.layout.remoteQuarantineDir, this.clock())) {
            this.onQuarantine?.(path.basename(this.layout.policyPath))
        }
        return { status: "missing" }
    }

    private async readParsed(): Promise<LatestPolicy | { readonly status: "malformed" }> {
        let raw: string
        try {
            raw = await fs.readFile(this.layout.policyPath, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" }
            throw error
        }
        try {
            return parsePolicyDocument(JSON.parse(raw))
        } catch {
            return { status: "malformed" }
        }
    }
}

function parsePolicyDocument(value: unknown): LatestPolicy | { readonly status: "malformed" } {
    if (!isRecord(value)) return { status: "malformed" }
    const schemaVersion = value.schema_version
    if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) return { status: "malformed" }
    if ((schemaVersion as number) > REMOTE_POLICY_SCHEMA_VERSION) return { status: "unsupported" }
    // A record or stop that cannot be read is a whole-document fault: guessing either half
    // could re-enable delivery, so the document is rejected and quarantined on the next write.
    let usage: UsagePolicyRecord | undefined
    if (value.usage !== undefined) {
        usage = parseRecord(value.usage)
        if (!usage) return { status: "malformed" }
    }
    let serverStop: ServerStop | undefined
    if (value.server_stop !== undefined) {
        serverStop = parseServerStop(value.server_stop)
        if (!serverStop) return { status: "malformed" }
    }
    return { status: "valid", raw: value, state: { ...(usage ? { usage } : {}), ...(serverStop ? { serverStop } : {}) } }
}

function parseRecord(value: unknown): UsagePolicyRecord | undefined {
    if (!isRecord(value) || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1) return undefined
    const decision = parseUsagePolicyDecision(value.decision)
    return decision ? { epoch: value.epoch as number, decision } : undefined
}

function serialize(state: RemotePolicyState): Record<string, unknown> {
    return {
        schema_version: REMOTE_POLICY_SCHEMA_VERSION,
        ...(state.usage ? { usage: { epoch: state.usage.epoch, decision: state.usage.decision } } : {}),
        ...(state.serverStop ? { server_stop: { scope: state.serverStop.scope, code: state.serverStop.code } } : {}),
    }
}

function sameState(left: RemotePolicyState, right: RemotePolicyState): boolean {
    return JSON.stringify(serialize(left)) === JSON.stringify(serialize(right))
}

function preserveUnknownFields(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !KNOWN_DOCUMENT_KEYS.has(key)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
