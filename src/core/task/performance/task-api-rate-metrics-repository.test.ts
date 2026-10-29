import fs from "node:fs/promises"
import path from "node:path"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { Logger } from "@shared/services/Logger"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LEGACY_API_RATE_METRICS_PARTITION, LegacyApiRateMetricsWrapperEntity } from "./api-rate-metrics-legacy-wrapper-entity"
import { ApiRateMetricsEntity, fromApiRateMetricsEntity } from "./api-rate-metrics-record-codec"
import {
    API_RATE_METRICS_SCHEMA_VERSION,
    ApiRateMetricsFileIntegrityError,
    type ApiRateSecondRecord,
} from "./api-rate-metrics-types"
import { TaskApiRateMetricsRepository } from "./task-api-rate-metrics-repository"

function secondRecord(second: number, overrides: Partial<ApiRateSecondRecord> = {}): ApiRateSecondRecord {
    return {
        schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
        kind: "second",
        second,
        revision: 0,
        signals: ["request_start"],
        requestCount: 1,
        estimatedTokens: 120,
        effectiveTokens: 120,
        tokenQuality: "estimated",
        runningActiveSeconds: 1,
        runningRequestCount: 1,
        runningTokenCount: 120,
        requestsPerMinute: 60,
        tokensPerMinute: 7_200,
        ...overrides,
    }
}

describe("TaskApiRateMetricsRepository", () => {
    let root: string
    const repositories: TaskApiRateMetricsRepository[] = []

    function createRepository(
        options: ConstructorParameters<typeof TaskApiRateMetricsRepository>[0],
    ): TaskApiRateMetricsRepository {
        const repository = new TaskApiRateMetricsRepository(options)
        repositories.push(repository)
        return repository
    }

    beforeEach(async () => {
        const parent = path.join(process.cwd(), "tmp")
        await fs.mkdir(parent, { recursive: true })
        root = await fs.mkdtemp(path.join(parent, "api-rate-metrics-"))
    })

    afterEach(async () => {
        await Promise.allSettled(repositories.splice(0).map((repository) => repository.close()))
        await fs.rm(root, { recursive: true, force: true })
    })

    it("does not log ordinary append success", async () => {
        const debug = vi.spyOn(Logger, "debug")
        const location = path.join(root, "api_rate_metrics_quiet_append.db")
        const repository = createRepository({ taskId: "task-a", location })
        await repository.initialize()
        debug.mockClear()

        await repository.append([secondRecord(10)])

        expect(debug.mock.calls.some(([message]) => message.includes("API rate metrics append:"))).toBe(false)
        debug.mockRestore()
    })

    it("creates Task-bound SQLite metrics and restores the latest running state", async () => {
        const location = path.join(root, "api_rate_metrics.db")
        const repository = createRepository({ taskId: "task-a", location, now: () => 1_000 })
        await repository.initialize()
        await repository.append([
            secondRecord(10),
            secondRecord(11, {
                signals: ["stream_tokens"],
                requestCount: 0,
                estimatedTokens: 180,
                effectiveTokens: 180,
                runningActiveSeconds: 2,
                runningRequestCount: 1,
                runningTokenCount: 300,
                requestsPerMinute: 30,
                tokensPerMinute: 9_000,
            }),
        ])
        await repository.waitForWrites()

        const stored = await repository.readAll()
        expect(stored.records).toHaveLength(2)
        expect(stored.physicalRecordCount).toBe(2)
        expect(stored.storageBytes).toBeGreaterThan(0)
        await repository.close()

        const reopened = createRepository({ taskId: "task-a", location })
        await expect(reopened.initialize()).resolves.toMatchObject({
            activeSeconds: 2,
            requestCount: 1,
            tokenCount: 300,
            lastActiveSecond: 11,
            snapshot: { activeSeconds: 2, requestsPerMinute: 30, tokensPerMinute: 9_000 },
            recentRecords: [expect.objectContaining({ second: 10 }), expect.objectContaining({ second: 11 })],
        })
    })

    it("restores API-active records while ignoring task-only seconds", async () => {
        const location = path.join(root, "api_rate_metrics_separate_activity.db")
        const repository = createRepository({ taskId: "task-a", location, now: () => 1_000 })
        await repository.initialize()
        await repository.append([
            secondRecord(10, {
                signals: ["task_active", "provider_active", "request_start", "stream_tokens"],
            }),
            secondRecord(11, {
                signals: ["task_active"],
                requestCount: 0,
                estimatedTokens: 0,
                effectiveTokens: 0,
                runningActiveSeconds: 2,
                runningProviderActiveSeconds: 1,
                runningRequestCount: 1,
                runningTokenCount: 120,
                requestsPerMinute: 30,
                tokensPerMinute: 7_200,
            }),
        ])
        await repository.waitForWrites()

        await repository.close()
        const reopened = createRepository({ taskId: "task-a", location })
        await expect(reopened.initialize()).resolves.toMatchObject({
            activeSeconds: 1,
            requestCount: 1,
            tokenCount: 120,
            lastActiveSecond: 10,
            snapshot: { activeSeconds: 1, requestsPerMinute: 60, tokensPerMinute: 7_200 },
            recentRecords: [expect.objectContaining({ second: 10 })],
        })
    })

    it("migrates the legacy SQLite wrapper into the flat schema without deleting the source", async () => {
        const location = path.join(root, "api_rate_metrics_wrapper_v1.db")
        const backend = new SqliteUnifyStoreBackend()
        const legacyDatabase = await backend.open(location)
        const legacyStore = await legacyDatabase.openStore(LegacyApiRateMetricsWrapperEntity)
        const meta = { schemaVersion: 1, kind: "meta", taskId: "task-a", createdAt: 1_000 } as const
        const revision0 = secondRecord(10, { revision: 0, effectiveTokens: 120 })
        const revision1 = secondRecord(10, { revision: 1, effectiveTokens: 180, runningTokenCount: 180 })
        const rollup = {
            schemaVersion: 1,
            kind: "rollup",
            resolution: "minute",
            bucketStartSecond: 60,
            bucketSeconds: 60,
            activeSeconds: 1,
            requestCount: 1,
            tokenCount: 180,
            requestsPerMinute: 60,
            tokensPerMinute: 10_800,
            tokenQuality: "exact",
        } as const
        await legacyStore.insert([
            new LegacyApiRateMetricsWrapperEntity(LEGACY_API_RATE_METRICS_PARTITION, "meta", -1, 0, meta),
            new LegacyApiRateMetricsWrapperEntity(LEGACY_API_RATE_METRICS_PARTITION, "second:10", 10, 0, revision0),
            new LegacyApiRateMetricsWrapperEntity(LEGACY_API_RATE_METRICS_PARTITION, "second:10", 10, 1, revision1),
            new LegacyApiRateMetricsWrapperEntity(LEGACY_API_RATE_METRICS_PARTITION, "rollup:minute:60", 60, 0, rollup),
        ])
        await legacyStore.close()
        await legacyDatabase.close()

        const repository = createRepository({ taskId: "task-a", location, migrateLegacy: false })
        await expect(repository.initialize()).resolves.toMatchObject({
            lastActiveSecond: 10,
            lastRecord: expect.objectContaining({ revision: 1, effectiveTokens: 180 }),
        })
        const migrated = await repository.readAll()
        expect(migrated.records.filter((record) => record.kind === "second")).toHaveLength(2)
        expect(migrated.records.filter((record) => record.kind === "rollup")).toHaveLength(1)
        await repository.close()

        const inspectionDatabase = await backend.open(location)
        expect(await inspectionDatabase.hasStore(LegacyApiRateMetricsWrapperEntity)).toBe(true)
        expect(await inspectionDatabase.hasStore(ApiRateMetricsEntity)).toBe(true)
        const source = await inspectionDatabase.openStore(LegacyApiRateMetricsWrapperEntity)
        expect((await source.query()).records).toHaveLength(4)
        await source.close()
        const target = await inspectionDatabase.openStore(ApiRateMetricsEntity)
        const targetRecords = (await target.query()).records.map(fromApiRateMetricsEntity)
        expect(targetRecords).toContainEqual(
            expect.objectContaining({
                kind: "migration",
                migrationKey: "api-rate-metrics-sqlite-wrapper-v1",
                importedRecords: 4,
            }),
        )
        await target.close()
        await inspectionDatabase.close()
    })

    it("automatically migrates legacy JSONL into SQLite and remains idempotent", async () => {
        const location = path.join(root, "api_rate_metrics_migrated.db")
        const legacySourcePath = path.join(root, "api_rate_metrics.jsonl")
        const content = [
            JSON.stringify({ schemaVersion: 1, kind: "meta", taskId: "task-a", createdAt: 1_000 }),
            JSON.stringify(secondRecord(10, { revision: 0 })),
            "{malformed}",
            JSON.stringify(secondRecord(10, { revision: 1, effectiveTokens: 180, runningTokenCount: 180 })),
            JSON.stringify({
                schemaVersion: 1,
                kind: "rollup",
                resolution: "minute",
                bucketStartSecond: 60,
                bucketSeconds: 60,
                activeSeconds: 1,
                requestCount: 1,
                tokenCount: 120,
                requestsPerMinute: 60,
                tokensPerMinute: 7_200,
                tokenQuality: "estimated",
            }),
            '{"schemaVersion":1,"kind":"second"',
        ].join("\n")
        await fs.writeFile(legacySourcePath, content, "utf8")

        const repository = createRepository({ taskId: "task-a", location, legacySourcePath, now: () => 2_000 })
        await expect(repository.initialize()).resolves.toMatchObject({
            degraded: true,
            lastActiveSecond: 10,
            lastRecord: expect.objectContaining({ revision: 1, effectiveTokens: 180 }),
        })
        const firstRead = await repository.readAll()
        expect(firstRead.degraded).toBe(true)
        expect(firstRead.records.filter((record) => record.kind === "second")).toHaveLength(2)
        expect(firstRead.records.filter((record) => record.kind === "rollup")).toHaveLength(1)
        expect(await fs.readFile(legacySourcePath, "utf8")).toBe(content)
        await repository.close()

        const reopened = createRepository({ taskId: "task-a", location, legacySourcePath })
        await reopened.initialize()
        const reopenedRead = await reopened.readAll()
        expect(reopenedRead.records).toEqual(firstRead.records)
        expect(reopenedRead.physicalRecordCount).toBe(firstRead.physicalRecordCount)
    })

    it("queries only canonical records inside the requested time range", async () => {
        const location = path.join(root, "api_rate_metrics_range.db")
        const repository = createRepository({ taskId: "task-a", location, migrateLegacy: false, now: () => 1_000 })
        await repository.initialize()
        await repository.append([
            secondRecord(9),
            secondRecord(10, { revision: 0, effectiveTokens: 100 }),
            secondRecord(10, { revision: 1, effectiveTokens: 180 }),
            secondRecord(20),
            {
                schemaVersion: 1,
                kind: "rollup",
                resolution: "minute",
                bucketStartSecond: 60,
                bucketSeconds: 60,
                activeSeconds: 1,
                requestCount: 1,
                tokenCount: 120,
                requestsPerMinute: 60,
                tokensPerMinute: 7_200,
                tokenQuality: "estimated",
            },
        ])

        await expect(repository.readRange({ startSecond: 10, endSecond: 61 })).resolves.toMatchObject({
            records: [
                expect.objectContaining({ kind: "second", second: 10, revision: 1, effectiveTokens: 180 }),
                expect.objectContaining({ kind: "second", second: 20 }),
                expect.objectContaining({ kind: "rollup", bucketStartSecond: 60 }),
            ],
            logicalRecordCount: 3,
            physicalRecordCount: 4,
        })
    })

    it("refuses an append that would exceed the logical hard limit without changing committed data", async () => {
        const location = path.join(root, "api_rate_metrics_hard_limit.db")
        const meta = { schemaVersion: 1, kind: "meta", taskId: "task-a", createdAt: 1_000 }
        const firstRecord = secondRecord(10)
        const hardLimitBytes = Buffer.byteLength(`${JSON.stringify(meta)}\n${JSON.stringify(firstRecord)}\n`)
        const repository = createRepository({
            taskId: "task-a",
            location,
            now: () => 1_000,
            hardLimitBytes,
        })
        await repository.initialize()
        await repository.append([firstRecord])
        const beforeRejectedAppend = await repository.readAll()

        await expect(repository.append([secondRecord(11)])).rejects.toThrow(/hard limit/i)
        await expect(repository.waitForWrites()).resolves.toBeUndefined()
        expect((await repository.readAll()).records).toEqual(beforeRejectedAppend.records)
    })

    it("atomically compacts files only after the configured size threshold", async () => {
        const location = path.join(root, "api_rate_metrics_compaction.db")
        const repository = createRepository({
            taskId: "task-a",
            location,
            compactionThresholdBytes: 1,
        })
        await repository.initialize()
        await repository.append([
            secondRecord(10, { requestCount: 1, effectiveTokens: 100 }),
            secondRecord(11, { requestCount: 0, effectiveTokens: 200 }),
        ])
        await repository.waitForWrites()

        await expect(repository.compactIfNeeded(10 + 3 * 24 * 60 * 60)).resolves.toBe(true)
        const read = await repository.readAll()
        expect(read.records).toEqual([
            expect.objectContaining({
                kind: "rollup",
                resolution: "minute",
                activeSeconds: 2,
                requestCount: 1,
                tokenCount: 300,
            }),
        ])
    })

    it("rejects a metrics database owned by another Task", async () => {
        const location = path.join(root, "api_rate_metrics_task_mismatch.db")
        const owner = createRepository({ taskId: "task-b", location, now: () => 1_000 })
        await owner.initialize()
        await owner.close()

        const repository = createRepository({ taskId: "task-a", location })
        await expect(repository.initialize()).rejects.toThrow(ApiRateMetricsFileIntegrityError)
    })
})
