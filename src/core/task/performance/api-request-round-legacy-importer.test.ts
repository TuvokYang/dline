import fs from "node:fs/promises"
import path from "node:path"
import type { UnifyStore, UnifyStoreTransaction } from "@core/storage/backend/api/UnifyStore"
import { eq } from "@core/storage/backend/api/UnifyStoreQuery"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import type { UiMessage } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ApiRequestRoundEntity } from "./api-request-round-entity"
import { ApiRequestRoundLegacyImportEntity } from "./api-request-round-legacy-import-entity"
import { importApiRequestRoundLegacyUsage } from "./api-request-round-legacy-importer"

function message(ts: number, say: UiMessage["say"], usage: object): UiMessage {
    return { ts, type: "say", say, text: JSON.stringify(usage) }
}

function exactRound(startedAtMs: number, apiIndex = 0): ApiRequestRoundEntity {
    return new ApiRequestRoundEntity({
        roundId: "exact-round",
        revision: 0,
        schemaVersion: 1,
        taskId: "task-a",
        logicalRequestId: "exact-request",
        apiIndex,
        taskAttempt: 0,
        providerAttempt: 0,
        startedAtMs,
        completedAtMs: startedAtMs + 100,
        providerDurationMs: 100,
        status: "completed",
        inputTokens: 100,
        outputTokens: 20,
        thoughtsTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        cacheUsageReported: true,
        totalCost: null,
        currency: null,
        usageQuality: "exact",
    })
}

function failTransactionInsert(
    store: UnifyStore<ApiRequestRoundLegacyImportEntity>,
): UnifyStore<ApiRequestRoundLegacyImportEntity> {
    return {
        query: (query) => store.query(query),
        insert: (records) => store.insert(records),
        upsert: (records) => store.upsert(records),
        replaceAll: (records) => store.replaceAll(records),
        transaction: <TResult>(
            operation: (transaction: UnifyStoreTransaction<ApiRequestRoundLegacyImportEntity>) => TResult | Promise<TResult>,
        ) =>
            store.transaction((transaction) =>
                operation({
                    query: (query) => transaction.query(query),
                    insert: async (records) => {
                        await transaction.insert(records)
                        throw new Error("forced legacy import rollback")
                    },
                    upsert: (records) => transaction.upsert(records),
                    replaceAll: (records) => transaction.replaceAll(records),
                }),
            ),
        stats: () => store.stats(),
        close: () => Promise.resolve(),
    }
}

describe("importApiRequestRoundLegacyUsage", () => {
    let root: string
    const closes: Array<() => Promise<void>> = []

    beforeEach(async () => {
        await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
        root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "api-request-round-legacy-import-"))
    })

    afterEach(async () => {
        for (const close of closes.splice(0).reverse()) await close().catch(() => undefined)
        await fs.rm(root, { recursive: true, force: true })
    })

    async function openStores(name: string) {
        const database = await new SqliteUnifyStoreBackend().open(path.join(root, `${name}.db`))
        const exactStore = await database.openStore(ApiRequestRoundEntity)
        const legacyStore = await database.openStore(ApiRequestRoundLegacyImportEntity)
        closes.push(async () => {
            await exactStore.close()
            await legacyStore.close()
            await database.close()
        })
        return { exactStore, legacyStore }
    }

    it("imports legacy rounds and aggregate-only usage once with a durable marker", async () => {
        const stores = await openStores("first")
        const messages = [
            message(1_000, "api_req_started", { tokensIn: 100, tokensOut: 20, cacheReads: 30 }),
            message(2_000, "deleted_api_reqs", { tokensIn: 50, tokensOut: 5 }),
        ]
        const source = { getAll: () => messages }

        await expect(
            importApiRequestRoundLegacyUsage({ taskId: "task-a", ...stores, source, clock: () => 5_000 }),
        ).resolves.toEqual({ degraded: false, importedRoundCount: 1, importedAggregateCount: 1 })
        messages.push(message(3_000, "api_req_started", { tokensIn: 900, tokensOut: 90 }))
        await expect(
            importApiRequestRoundLegacyUsage({ taskId: "task-a", ...stores, source, clock: () => 6_000 }),
        ).resolves.toEqual({ degraded: false, importedRoundCount: 1, importedAggregateCount: 1 })

        const rows = await stores.legacyStore.query()
        expect(rows.records.map(({ kind }) => kind).sort()).toEqual(["aggregate", "legacy_round", "marker"])
        expect(rows.records.find(({ kind }) => kind === "marker")).toMatchObject({
            importedRoundCount: 1,
            importedAggregateCount: 1,
            importedAtMs: 5_000,
        })
    })

    it("imports only messages before the earliest exact send and marks excluded overlap degraded", async () => {
        const stores = await openStores("cutoff")
        await stores.exactStore.insert([exactRound(2_000, 1)])
        const source = {
            getAll: () => [
                message(1_000, "api_req_started", { tokensIn: 100, tokensOut: 20 }),
                message(3_000, "api_req_started", { tokensIn: 300, tokensOut: 30 }),
            ],
        }

        await expect(
            importApiRequestRoundLegacyUsage({ taskId: "task-a", ...stores, source, clock: () => 5_000 }),
        ).resolves.toEqual({ degraded: true, importedRoundCount: 1, importedAggregateCount: 0 })
        const legacyRounds = await stores.legacyStore.query({
            where: eq(ApiRequestRoundLegacyImportEntity.storage.fields.kind, "legacy_round"),
        })
        expect(legacyRounds.records.map(({ messageTs }) => messageTs)).toEqual([1_000])
    })

    it("does not reimport the current exact send when its UI message precedes transport start", async () => {
        const stores = await openStores("same-api-index")
        await stores.exactStore.insert([exactRound(2_000, 0)])
        const source = {
            getAll: () => [message(1_900, "api_req_started", { tokensIn: 100, tokensOut: 20 })],
        }

        await expect(
            importApiRequestRoundLegacyUsage({ taskId: "task-a", ...stores, source, clock: () => 5_000 }),
        ).resolves.toEqual({ degraded: true, importedRoundCount: 0, importedAggregateCount: 0 })
        const legacyRounds = await stores.legacyStore.query({
            where: eq(ApiRequestRoundLegacyImportEntity.storage.fields.kind, "legacy_round"),
        })
        expect(legacyRounds.records).toHaveLength(0)
    })

    it("rolls back rows and marker together so a later import can retry", async () => {
        const stores = await openStores("rollback")
        const source = { getAll: () => [message(1_000, "api_req_started", { tokensIn: 100, tokensOut: 20 })] }

        await expect(
            importApiRequestRoundLegacyUsage({
                taskId: "task-a",
                exactStore: stores.exactStore,
                legacyStore: failTransactionInsert(stores.legacyStore),
                source,
                clock: () => 5_000,
            }),
        ).rejects.toThrow("forced legacy import rollback")
        await expect(stores.legacyStore.query()).resolves.toMatchObject({ records: [] })
        await expect(
            importApiRequestRoundLegacyUsage({ taskId: "task-a", ...stores, source, clock: () => 6_000 }),
        ).resolves.toEqual({ degraded: false, importedRoundCount: 1, importedAggregateCount: 0 })
    })

    it("serializes concurrent imports into one marker-backed result", async () => {
        const stores = await openStores("concurrent")
        const source = { getAll: () => [message(1_000, "api_req_started", { tokensIn: 100, tokensOut: 20 })] }

        const results = await Promise.all([
            importApiRequestRoundLegacyUsage({ taskId: "task-a", ...stores, source, clock: () => 5_000 }),
            importApiRequestRoundLegacyUsage({ taskId: "task-a", ...stores, source, clock: () => 6_000 }),
        ])

        expect(results).toEqual([
            { degraded: false, importedRoundCount: 1, importedAggregateCount: 0 },
            { degraded: false, importedRoundCount: 1, importedAggregateCount: 0 },
        ])
        const rows = await stores.legacyStore.query()
        expect(rows.records).toHaveLength(2)
    })
})
