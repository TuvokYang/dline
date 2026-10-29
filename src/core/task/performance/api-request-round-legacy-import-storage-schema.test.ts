import { describe, expect, it } from "vitest"
import { ApiRequestRoundLegacyImportEntity } from "./api-request-round-legacy-import-entity"

describe("ApiRequestRoundLegacyImportEntity storage schema", () => {
    it("stores legacy round, aggregate, and marker facts in independent non-JSON columns", () => {
        const fields = ApiRequestRoundLegacyImportEntity.storage.columnEntries
        expect(fields.map(({ name }) => name)).toEqual([
            "recordKey",
            "schemaVersion",
            "taskId",
            "kind",
            "sourceKey",
            "messageTs",
            "roundId",
            "logicalRequestId",
            "apiIndex",
            "inputTokens",
            "outputTokens",
            "cacheWriteTokens",
            "cacheReadTokens",
            "cacheUsageReported",
            "totalCost",
            "currency",
            "aggregateKind",
            "sourceFingerprint",
            "importedRoundCount",
            "importedAggregateCount",
            "degraded",
            "importedAtMs",
        ])
        expect(fields.every(({ column }) => column.kind !== "json")).toBe(true)
        expect(ApiRequestRoundLegacyImportEntity.storage.primaryFields.map(({ name }) => name)).toEqual(["recordKey"])
    })
})
