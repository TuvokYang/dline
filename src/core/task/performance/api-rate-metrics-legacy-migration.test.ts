import fs from "node:fs/promises"
import path from "node:path"
import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { migrateLegacyApiRateMetrics } from "./api-rate-metrics-legacy-migration"
import { ApiRateMetricsEntity, fromApiRateMetricsEntity, toApiRateMetricsEntity } from "./api-rate-metrics-record-codec"
import {
    API_RATE_METRICS_SCHEMA_VERSION,
    ApiRateMetricsFileIntegrityError,
    type ApiRateRollupRecord,
    type ApiRateSecondRecord,
} from "./api-rate-metrics-types"

function secondRecord(second: number, revision = 0): ApiRateSecondRecord {
    return {
        schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
        kind: "second",
        second,
        revision,
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
    }
}

const rollup: ApiRateRollupRecord = {
    schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
    kind: "rollup",
    resolution: "minute",
    bucketStartSecond: 60,
    bucketSeconds: 60,
    activeSeconds: 2,
    requestCount: 1,
    tokenCount: 240,
    requestsPerMinute: 30,
    tokensPerMinute: 7_200,
    tokenQuality: "mixed",
}

describe("legacy API rate metrics migration", () => {
    let root: string
    const collections: UnifyStore<ApiRateMetricsEntity>[] = []

    beforeEach(async () => {
        const parent = path.join(process.cwd(), "tmp")
        await fs.mkdir(parent, { recursive: true })
        root = await fs.mkdtemp(path.join(parent, "api-rate-metrics-migration-"))
    })

    afterEach(async () => {
        await Promise.allSettled(collections.splice(0).map((collection) => collection.close()))
        await fs.rm(root, { recursive: true, force: true })
    })

    async function openCollection(name: string): Promise<UnifyStore<ApiRateMetricsEntity>> {
        const database = await new SqliteUnifyStoreBackend().open(path.join(root, `${name}.db`))
        const collection = await database.openStore(ApiRateMetricsEntity)
        const closeCollection = collection.close.bind(collection)
        let closePromise: Promise<void> | undefined
        collection.close = () => {
            closePromise ??= closeCollection().then(() => database.close())
            return closePromise
        }
        collections.push(collection)
        return collection
    }

    it("imports all valid revisions and rollups with one durable marker", async () => {
        const sourcePath = path.join(root, "api_rate_metrics.jsonl")
        const content = [
            JSON.stringify({ schemaVersion: 1, kind: "meta", taskId: "task-a", createdAt: 1_000 }),
            JSON.stringify(secondRecord(10, 0)),
            "{malformed}",
            JSON.stringify(secondRecord(10, 1)),
            JSON.stringify(rollup),
            '{"schemaVersion":1,"kind":"second"',
        ].join("\n")
        await fs.writeFile(sourcePath, content, "utf8")
        const collection = await openCollection("complete")

        const result = await migrateLegacyApiRateMetrics({
            taskId: "task-a",
            collection,
            sourcePath,
            now: () => 2_000,
        })
        expect(result).toMatchObject({ imported: true, marker: { importedRecords: 4, degraded: true, completedAt: 2_000 } })
        const stored = await collect(collection)
        expect(stored.filter((record) => record.kind === "second")).toHaveLength(2)
        expect(stored.filter((record) => record.kind === "rollup")).toHaveLength(1)
        expect(stored.filter((record) => record.kind === "migration")).toHaveLength(1)
        expect(await fs.readFile(sourcePath, "utf8")).toBe(content)
    })

    it("is idempotent for the same source and rejects a changed source", async () => {
        const sourcePath = path.join(root, "api_rate_metrics.jsonl")
        await fs.writeFile(
            sourcePath,
            `${JSON.stringify({ schemaVersion: 1, kind: "meta", taskId: "task-a", createdAt: 1_000 })}\n`,
            "utf8",
        )
        const collection = await openCollection("idempotent")
        expect((await migrateLegacyApiRateMetrics({ taskId: "task-a", collection, sourcePath })).imported).toBe(true)
        const count = (await collect(collection)).length
        expect((await migrateLegacyApiRateMetrics({ taskId: "task-a", collection, sourcePath })).imported).toBe(false)
        expect((await collect(collection)).length).toBe(count)

        await fs.appendFile(sourcePath, `${JSON.stringify(secondRecord(10))}\n`, "utf8")
        await expect(migrateLegacyApiRateMetrics({ taskId: "task-a", collection, sourcePath })).rejects.toThrow(/changed/i)
    })

    it("serializes concurrent imports of the same legacy source across two handles", async () => {
        const sourcePath = path.join(root, "concurrent.jsonl")
        await fs.writeFile(
            sourcePath,
            `${[
                JSON.stringify({ schemaVersion: 1, kind: "meta", taskId: "task-a", createdAt: 1_000 }),
                JSON.stringify(secondRecord(10)),
            ].join("\n")}\n`,
            "utf8",
        )
        const [left, right] = await Promise.all([openCollection("concurrent"), openCollection("concurrent")])

        const results = await Promise.all([
            migrateLegacyApiRateMetrics({ taskId: "task-a", collection: left, sourcePath }),
            migrateLegacyApiRateMetrics({ taskId: "task-a", collection: right, sourcePath }),
        ])
        expect(results.map((result) => result.imported).sort()).toEqual([false, true])
        const stored = await collect(left)
        expect(stored.filter((record) => record.kind === "meta")).toHaveLength(1)
        expect(stored.filter((record) => record.kind === "second")).toHaveLength(1)
        expect(stored.filter((record) => record.kind === "migration")).toHaveLength(1)
    })

    it("rejects Task mismatch and a non-empty unmarked target without partial writes", async () => {
        const mismatchPath = path.join(root, "mismatch.jsonl")
        await fs.writeFile(
            mismatchPath,
            `${JSON.stringify({ schemaVersion: 1, kind: "meta", taskId: "task-b", createdAt: 1_000 })}\n`,
            "utf8",
        )
        const mismatch = await openCollection("mismatch")
        await expect(
            migrateLegacyApiRateMetrics({ taskId: "task-a", collection: mismatch, sourcePath: mismatchPath }),
        ).rejects.toThrow(ApiRateMetricsFileIntegrityError)
        expect(await collect(mismatch)).toEqual([])

        const sourcePath = path.join(root, "non-empty.jsonl")
        await fs.writeFile(
            sourcePath,
            `${JSON.stringify({ schemaVersion: 1, kind: "meta", taskId: "task-a", createdAt: 1_000 })}\n`,
            "utf8",
        )
        const nonEmpty = await openCollection("non-empty")
        await nonEmpty.insert([toApiRateMetricsEntity(secondRecord(10))])
        await expect(migrateLegacyApiRateMetrics({ taskId: "task-a", collection: nonEmpty, sourcePath })).rejects.toThrow(
            /non-empty target/i,
        )
        expect((await collect(nonEmpty)).filter((record) => record.kind === "second")).toHaveLength(1)
    })
})

async function collect(collection: UnifyStore<ApiRateMetricsEntity>) {
    return (await collection.query()).records.map(fromApiRateMetricsEntity)
}
