import fs from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { physicalTableName } from "@core/storage/backend/sqlite/SqliteSchemaCompiler"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ApiRequestRoundEntity } from "./api-request-round-entity"

const EXPECTED_COLUMNS = [
    "roundId",
    "revision",
    "schemaVersion",
    "taskId",
    "logicalRequestId",
    "apiIndex",
    "taskAttempt",
    "providerAttempt",
    "startedAtMs",
    "completedAtMs",
    "providerDurationMs",
    "status",
    "inputTokens",
    "outputTokens",
    "thoughtsTokens",
    "cacheWriteTokens",
    "cacheReadTokens",
    "cacheUsageReported",
    "totalCost",
    "currency",
    "usageQuality",
] as const

describe("ApiRequestRoundEntity storage schema", () => {
    let root: string

    beforeEach(async () => {
        await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
        root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "api-request-round-schema-"))
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    it("maps every durable round fact to an independent non-JSON column", () => {
        expect(ApiRequestRoundEntity.storage.columnEntries.map(({ name }) => name)).toEqual(EXPECTED_COLUMNS)
        expect(ApiRequestRoundEntity.storage.columnEntries.every(({ column }) => column.kind !== "json")).toBe(true)
        expect(ApiRequestRoundEntity.storage.primaryFields.map(({ name }) => name)).toEqual(["roundId", "revision"])
    })

    it("compiles SQLite columns directly from the class schema", async () => {
        const location = path.join(root, "task.db")
        const database = await new SqliteUnifyStoreBackend().open(location)
        const store = await database.openStore(ApiRequestRoundEntity)
        await store.close()
        await database.close()

        const sqlite = new DatabaseSync(location)
        try {
            const columns = sqlite
                .prepare('SELECT name, type, "notnull" AS is_not_null, pk FROM pragma_table_info(?) ORDER BY cid')
                .all(physicalTableName(ApiRequestRoundEntity.storage.schemaId)) as Array<{
                name: string
                type: string
                is_not_null: number
                pk: number
            }>
            expect(columns.map(({ name }) => name)).toEqual(EXPECTED_COLUMNS)
            expect(columns.filter(({ pk }) => pk > 0).map(({ name }) => name)).toEqual(["roundId", "revision"])
        } finally {
            sqlite.close()
        }
    })
})
