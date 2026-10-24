import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { renameWithRetry, writeJsonAtomic } from "@shared/storage/atomic-file"
import { validateUsageAttemptObservation } from "@/services/telemetry/remote/usage/attemptBucket"
import type { UsageAttemptObservation } from "@/services/telemetry/remote/usage/attemptProjection"
import type { UsageAttemptObservationRejection } from "@/services/telemetry/remote/usage/usageOutbox"
import type { OtelStorageLayout } from "./OtelStorageLayout"

/**
 * A sealed shard must sit this long after both its seal and its last write
 * before it is read, so an append that opened the file just before the seal has
 * landed in it.
 */
export const SEALED_SHARD_SETTLE_MS = 5_000
/** Observation IDs remembered per process; settlement already happens once, this only absorbs a duplicate call. */
const REMEMBERED_APPENDS = 4_096
const ACTIVE_SUFFIX = ".jsonl"
const SEALED_SUFFIX = ".sealed.jsonl"
const ATTEMPT_ACTIVE_SUFFIX = ".attempts.jsonl"
const ATTEMPT_SEALED_SUFFIX = ".attempts.sealed.jsonl"
const SHARD_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const ATTEMPT_SEALED_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}\.(\d{1,16})\.attempts\.sealed\.jsonl$/

export interface PendingUsageAttemptObservation {
    readonly id: string
    readonly revision: number
    readonly receivedAt: number
    readonly observation: UsageAttemptObservation
}

export interface SettledUsageAttemptShard {
    readonly name: string
    readonly observations: readonly PendingUsageAttemptObservation[]
}

/**
 * Process-sharded observation spool under `telemetry/remote/usage/observations`.
 *
 * Each extension host appends only to its own shard, so the hot path needs no
 * cross-process lock. The sender seals shards by renaming them and reads a
 * sealed shard only after it settled; an append racing the seal either lands in
 * the sealed file before it is read or starts a fresh active shard.
 */
export class UsageObservationSpool {
    private readonly directory: string
    private readonly quarantineDirectory: string
    private readonly appendedAttempts = new Set<string>()

    constructor(
        layout: OtelStorageLayout,
        private readonly shardId: string,
    ) {
        if (!SHARD_NAME_PATTERN.test(shardId)) throw new Error("Usage shard id must be a short file-safe token")
        this.directory = layout.usageObservationsDir
        this.quarantineDirectory = layout.remoteQuarantineDir
    }

    /** Append one finalized schema 4 attempt revision to this process shard. */
    async appendAttempt(observation: PendingUsageAttemptObservation): Promise<void> {
        const key = `${observation.id}:${observation.revision}`
        if (this.appendedAttempts.has(key)) return
        validateUsageAttemptObservation(observation.observation)
        if (observation.observation.attemptObservationId !== observation.id) {
            throw new Error("Usage attempt envelope identity does not match the observation")
        }
        await fs.mkdir(this.directory, { recursive: true })
        await fs.appendFile(
            path.join(this.directory, `${this.shardId}${ATTEMPT_ACTIVE_SUFFIX}`),
            `${JSON.stringify(observation)}\n`,
        )
        this.rememberAttempt(key)
    }

    async sealActiveAttempts(now: number): Promise<void> {
        for (const name of await this.list()) {
            if (!name.endsWith(ATTEMPT_ACTIVE_SUFFIX)) continue
            const shard = name.slice(0, -ATTEMPT_ACTIVE_SUFFIX.length)
            const sealed = path.join(this.directory, `${shard}.${now}${ATTEMPT_SEALED_SUFFIX}`)
            if (await exists(sealed)) continue
            try {
                await renameWithRetry(path.join(this.directory, name), sealed)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
        }
    }

    async readSettledAttempts(now: number): Promise<{ readonly shards: SettledUsageAttemptShard[]; readonly skipped: number }> {
        const settledNames: string[] = []
        const highestByAttempt = new Map<
            string,
            { readonly shardName: string; readonly observation: PendingUsageAttemptObservation }
        >()
        let skipped = 0
        for (const name of await this.list()) {
            const sealedAt = ATTEMPT_SEALED_NAME_PATTERN.exec(name)?.[1]
            if (sealedAt === undefined) continue
            const filePath = path.join(this.directory, name)
            const stat = await fs.stat(filePath).catch(() => undefined)
            if (!stat || now - Math.max(Number(sealedAt), stat.mtimeMs) < SEALED_SHARD_SETTLE_MS) continue
            const content = await readIfPresent(filePath)
            if (content === undefined) continue
            settledNames.push(name)
            for (const [lineIndex, line] of content.split("\n").entries()) {
                if (!line.trim()) continue
                const observation = parseAttemptObservation(line)
                if (!observation) {
                    skipped++
                    await this.quarantineLine(name, lineIndex + 1, line)
                    continue
                }
                const current = highestByAttempt.get(observation.id)
                if (!current || observation.revision > current.observation.revision) {
                    highestByAttempt.set(observation.id, { shardName: name, observation })
                }
            }
        }

        const observationsByShard = new Map(settledNames.map((name) => [name, [] as PendingUsageAttemptObservation[]]))
        for (const { shardName, observation } of highestByAttempt.values()) {
            observationsByShard.get(shardName)?.push(observation)
        }
        return {
            shards: settledNames.map((name) => ({ name, observations: observationsByShard.get(name) ?? [] })),
            skipped,
        }
    }

    /** Persist schema 4 reduction/checkpoint rejects before their source shards are acknowledged. */
    async quarantineRejectedAttempts(rejections: readonly UsageAttemptObservationRejection[]): Promise<void> {
        for (const rejection of rejections) {
            const pending = rejection.observation
            const identity = `${rejection.shardName}\u0000${pending.id}\u0000${pending.revision}`
            const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24)
            await writeJsonAtomic(
                path.join(this.quarantineDirectory, `usage-attempt-${digest}.json`),
                {
                    kind: "usage_attempt_rejected",
                    shard: rejection.shardName,
                    violations: rejection.violations,
                    observation: pending,
                },
                { fsync: true },
            )
        }
    }

    async discardAttempts(names: readonly string[]): Promise<void> {
        for (const name of names) {
            if (!ATTEMPT_SEALED_NAME_PATTERN.test(name)) continue
            await fs.rm(path.join(this.directory, name), { force: true })
        }
    }

    /** Destructive schema 4 clean-cut: remove only legacy schema 3 observation shards. */
    async purgeLegacy(): Promise<void> {
        for (const name of await this.list()) {
            if (name.endsWith(ATTEMPT_ACTIVE_SUFFIX) || name.endsWith(ATTEMPT_SEALED_SUFFIX)) continue
            if (!name.endsWith(ACTIVE_SUFFIX) && !name.endsWith(SEALED_SUFFIX)) continue
            await fs.rm(path.join(this.directory, name), { force: true })
        }
    }

    /** Delete every unsent observation, for example when the user turns usage reporting off. */
    async purge(): Promise<void> {
        await fs.rm(this.directory, { recursive: true, force: true })
        this.appendedAttempts.clear()
    }

    private async quarantineLine(shardName: string, lineNumber: number, line: string): Promise<void> {
        const identity = `${shardName}\u0000${lineNumber}\u0000${line}`
        const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24)
        await writeJsonAtomic(
            path.join(this.quarantineDirectory, `usage-line-${digest}.json`),
            {
                kind: "usage_observation_malformed",
                shard: shardName,
                line_number: lineNumber,
                raw: line.slice(0, 64 * 1024),
            },
            { fsync: true },
        )
    }

    private rememberAttempt(key: string): void {
        this.appendedAttempts.add(key)
        if (this.appendedAttempts.size <= REMEMBERED_APPENDS) return
        const oldest = this.appendedAttempts.values().next().value
        if (oldest !== undefined) this.appendedAttempts.delete(oldest)
    }

    private async list(): Promise<string[]> {
        return (await fs.readdir(this.directory).catch(() => [] as string[])).sort()
    }
}

async function exists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(
        () => true,
        () => false,
    )
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
    try {
        return await fs.readFile(filePath, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
    }
}

function parseAttemptObservation(line: string): PendingUsageAttemptObservation | undefined {
    let value: Record<string, unknown>
    try {
        value = JSON.parse(line) as Record<string, unknown>
    } catch {
        return undefined
    }
    const { id, revision, receivedAt, observation } = value
    if (typeof id !== "string" || id.length === 0) return undefined
    if (!Number.isSafeInteger(revision) || (revision as number) < 0 || !Number.isSafeInteger(receivedAt)) return undefined
    if (typeof observation !== "object" || observation === null) return undefined
    try {
        validateUsageAttemptObservation(observation as UsageAttemptObservation)
    } catch {
        return undefined
    }
    const parsed = observation as UsageAttemptObservation
    if (parsed.attemptObservationId !== id) return undefined
    return { id, revision: revision as number, receivedAt: receivedAt as number, observation: parsed }
}
