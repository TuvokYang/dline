import { describe, expectTypeOf, it } from "vitest"
import type {
    UnifyStore,
    UnifyStoreBackend,
    UnifyStoreDatabase,
    UnifyStoreResult,
    UnifyStoreStats,
    UnifyStoreTransaction,
} from "../../api/UnifyStore"

interface TestEntity {
    readonly id: string
}

describe("UnifyStore public API", () => {
    it("exposes only backend-neutral physical stats", () => {
        expectTypeOf<keyof UnifyStoreStats>().toEqualTypeOf<"storageBytes" | "storedRecordCount" | "degraded">()
    })

    it("keeps store, transaction, result, database and backend generics aligned", () => {
        expectTypeOf<UnifyStore<TestEntity>>().toHaveProperty("query")
        expectTypeOf<UnifyStoreTransaction<TestEntity>>().toHaveProperty("insert")
        expectTypeOf<UnifyStoreResult<TestEntity>["records"]>().toEqualTypeOf<TestEntity[]>()
        expectTypeOf<UnifyStoreDatabase>().toHaveProperty("hasStore")
        expectTypeOf<UnifyStoreDatabase>().toHaveProperty("openStore")
        expectTypeOf<UnifyStoreBackend>().toHaveProperty("open")
    })
})
