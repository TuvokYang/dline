import fs from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { physicalTableName } from "@core/storage/backend/sqlite/SqliteSchemaCompiler"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ApiRateMetricsEntity } from "./api-rate-metrics-record-codec"

const EXPECTED_COLUMNS = [
    "recordKey",
    "revision",
    "schemaVersion",
    "kind",
    "startSecond",
    "taskId",
    "createdAt",
    "second",
    "signalsMask",
    "requestCount",
    "estimatedTokens",
    "effectiveTokens",
    "tokenQuality",
    "runningActiveSeconds",
    "runningProviderActiveSeconds",
    "runningRequestCount",
    "runningTokenCount",
    "requestsPerMinute",
    "tokensPerMinute",
    "resolution",
    "bucketStartSecond",
    "bucketSeconds",
    "activeSeconds",
    "providerActiveSeconds",
    "tokenCount",
    "migrationKey",
    "sourceFingerprint",
    "importedRecords",
    "degraded",
    "completedAt",
] as const

describe("API rate metrics flat storage schema", () => {
    let root: string

    beforeEach(async () => {
        const parent = path.join(process.cwd(), "tmp")
        await fs.mkdir(parent, { recursive: true })
        root = await fs.mkdtemp(path.join(parent, "api-rate-metrics-schema-"))
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    it("declares every durable business fact as a class-first column", () => {
        const entries = ApiRateMetricsEntity.storage.columnEntries
        expect(entries.map(({ name }) => name)).toEqual(EXPECTED_COLUMNS)
        expect(entries.some(({ name }) => name === ("record" as never))).toBe(false)
        expect(entries.some(({ column }) => column.kind === "json")).toBe(false)
        expect(ApiRateMetricsEntity.storage.primaryFields.map(({ name }) => name)).toEqual(["recordKey", "revision"])
    })

    it("creates the SQLite table directly from the flat entity schema", async () => {
        const location = path.join(root, "metrics.db")
        const database = await new SqliteUnifyStoreBackend().open(location)
        const store = await database.openStore(ApiRateMetricsEntity)
        await store.close()
        await database.close()

        const inspection = new DatabaseSync(location)
        try {
            const rows = inspection
                .prepare('SELECT name, type, "notnull" AS is_not_null, pk FROM pragma_table_info(?) ORDER BY cid')
                .all(physicalTableName(ApiRateMetricsEntity.storage.schemaId)) as unknown as Array<{
                name: string
                type: string
                is_not_null: number
                pk: number
            }>
            expect(rows.map(({ name }) => name)).toEqual(EXPECTED_COLUMNS)
            expect(rows.some(({ name }) => name === "record")).toBe(false)
            expect(rows.filter(({ pk }) => pk > 0).map(({ name }) => name)).toEqual(["recordKey", "revision"])
        } finally {
            inspection.close()
        }
    })
})
