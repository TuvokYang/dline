import fs from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { physicalTableName } from "@core/storage/backend/sqlite/SqliteSchemaCompiler"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ApiRequestRoundEntity } from "./api-request-round-entity"
import { ApiResponseExecutionEntity } from "./api-response-execution-entity"

const EXPECTED_COLUMNS = [
    "executionId",
    "revision",
    "schemaVersion",
    "taskId",
    "roundId",
    "logicalRequestId",
    "apiIndex",
    "taskAttempt",
    "providerAttempt",
    "startedAtMs",
    "providerCompletedAtMs",
    "completedAtMs",
    "providerDurationMs",
    "executionDurationMs",
    "status",
    "terminalKind",
    "toolCount",
    "completedToolCount",
    "failedToolCount",
    "cancelledToolCount",
] as const

describe("ApiResponseExecutionEntity storage schema", () => {
    let root: string

    beforeEach(async () => {
        await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
        root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "api-response-execution-schema-"))
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    it("uses a separate flat schema without mutating the registered Provider round schema", () => {
        expect(ApiResponseExecutionEntity.storage.schemaId).toBe("api-response-execution-flat")
        expect(ApiResponseExecutionEntity.storage.columnEntries.map(({ name }) => name)).toEqual(EXPECTED_COLUMNS)
        expect(ApiResponseExecutionEntity.storage.columnEntries.every(({ column }) => column.kind !== "json")).toBe(true)
        expect(ApiResponseExecutionEntity.storage.primaryFields.map(({ name }) => name)).toEqual(["executionId", "revision"])
        expect(ApiRequestRoundEntity.storage.columnEntries.map(({ name }) => name)).not.toContain("executionDurationMs")
        expect(ApiResponseExecutionEntity.storage.fingerprint).not.toBe(ApiRequestRoundEntity.storage.fingerprint)
    })

    it("compiles every execution fact into an independent SQLite column", async () => {
        const location = path.join(root, "task.db")
        const database = await new SqliteUnifyStoreBackend().open(location)
        const store = await database.openStore(ApiResponseExecutionEntity)
        await store.close()
        await database.close()

        const sqlite = new DatabaseSync(location)
        try {
            const columns = sqlite
                .prepare('SELECT name, type, "notnull" AS is_not_null, pk FROM pragma_table_info(?) ORDER BY cid')
                .all(physicalTableName(ApiResponseExecutionEntity.storage.schemaId)) as Array<{
                name: string
                type: string
                is_not_null: number
                pk: number
            }>
            expect(columns.map(({ name }) => name)).toEqual(EXPECTED_COLUMNS)
            expect(columns.filter(({ pk }) => pk > 0).map(({ name }) => name)).toEqual(["executionId", "revision"])
        } finally {
            sqlite.close()
        }
    })
})
