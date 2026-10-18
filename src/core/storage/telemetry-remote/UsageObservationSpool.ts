import fs from "node:fs/promises"
import path from "node:path"
import { renameWithRetry } from "@shared/storage/atomic-file"
import type { OtelStorageLayout } from "./OtelStorageLayout"

/** One settled request as it waits in a process shard, already projected onto the remote catalog. */
export interface SpooledObservation {
    readonly id: string
    /** Local receipt time, epoch milliseconds; the sender assigns the UTC minute. */
    readonly receivedAt: number
    readonly counters: Readonly<Record<string, number>>
    readonly measurements: Readonly<Record<string, { count: number; sum: number; min: number; max: number }>>
}

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
const SHARD_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const SEALED_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}\.(\d{1,16})\.sealed\.jsonl$/

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
    private readonly appended = new Set<string>()

    constructor(
        layout: OtelStorageLayout,
        private readonly shardId: string,
    ) {
        if (!SHARD_NAME_PATTERN.test(shardId)) throw new Error("Usage shard id must be a short file-safe token")
        this.directory = path.join(layout.usageDir, "observations")
    }

    /** Append one observation; an ID this process already appended is ignored. */
    async append(observation: SpooledObservation): Promise<void> {
        if (this.appended.has(observation.id)) return
        this.remember(observation.id)
        await fs.mkdir(this.directory, { recursive: true })
        await fs.appendFile(path.join(this.directory, `${this.shardId}${ACTIVE_SUFFIX}`), `${JSON.stringify(observation)}\n`)
    }

    /** Seal every active shard, from every process, so its contents become sendable after they settle. */
    async sealActive(now: number): Promise<void> {
        for (const name of await this.list()) {
            if (!name.endsWith(ACTIVE_SUFFIX) || name.endsWith(SEALED_SUFFIX)) continue
            const shard = name.slice(0, -ACTIVE_SUFFIX.length)
            const sealed = path.join(this.directory, `${shard}.${now}${SEALED_SUFFIX}`)
            // A rename onto an existing sealed shard would replace it on POSIX; the next cycle seals instead.
            if (await exists(sealed)) continue
            try {
                await renameWithRetry(path.join(this.directory, name), sealed)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
        }
    }

    /**
     * Read sealed shards that have settled. Malformed lines are skipped and counted
     * rather than failing the batch, so one torn write cannot block every later minute.
     */
    async readSettled(
        now: number,
    ): Promise<{ readonly files: string[]; readonly observations: SpooledObservation[]; readonly skipped: number }> {
        const files: string[] = []
        const observations: SpooledObservation[] = []
        const seen = new Set<string>()
        let skipped = 0
        for (const name of await this.list()) {
            const sealedAt = SEALED_NAME_PATTERN.exec(name)?.[1]
            if (sealedAt === undefined) continue
            const filePath = path.join(this.directory, name)
            const stat = await fs.stat(filePath).catch(() => undefined)
            if (!stat || now - Math.max(Number(sealedAt), stat.mtimeMs) < SEALED_SHARD_SETTLE_MS) continue
            const content = await readIfPresent(filePath)
            if (content === undefined) continue
            files.push(filePath)
            for (const line of content.split("\n")) {
                if (!line.trim()) continue
                const observation = parseObservation(line)
                if (!observation) skipped++
                else if (!seen.has(observation.id)) {
                    seen.add(observation.id)
                    observations.push(observation)
                }
            }
        }
        return { files, observations, skipped }
    }

    /** Remove sealed shards once their contents are safely inside a published inflight batch. */
    async discard(files: readonly string[]): Promise<void> {
        for (const file of files) await fs.rm(file, { force: true })
    }

    /** Delete every unsent observation, for example when the user turns usage reporting off. */
    async purge(): Promise<void> {
        await fs.rm(this.directory, { recursive: true, force: true })
        this.appended.clear()
    }

    private remember(id: string): void {
        this.appended.add(id)
        if (this.appended.size <= REMEMBERED_APPENDS) return
        const oldest = this.appended.values().next().value
        if (oldest !== undefined) this.appended.delete(oldest)
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

function parseObservation(line: string): SpooledObservation | undefined {
    try {
        const value = JSON.parse(line) as Partial<SpooledObservation>
        if (typeof value.id !== "string" || !Number.isSafeInteger(value.receivedAt)) return undefined
        if (!isNumberRecord(value.counters) || typeof value.measurements !== "object" || value.measurements === null)
            return undefined
        return value as SpooledObservation
    } catch {
        return undefined
    }
}

function isNumberRecord(value: unknown): value is Record<string, number> {
    return (
        typeof value === "object" &&
        value !== null &&
        Object.values(value).every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)
    )
}
