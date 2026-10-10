import { describe, expect, expectTypeOf, it } from "vitest"
import { column, defineEntity } from "../../api/EntitySchema"
import { asc, desc, eq, latestPerGroup, type UnifyStoreOrder } from "../../api/UnifyStoreQuery"

class RankedEntity {
    static readonly storage = defineEntity<RankedEntity>()({
        schemaId: "ranked-entity",
        version: 1,
        columns: {
            id: column.text({ primary: true }),
            group: column.text({ indexed: true }),
            rank: column.integer({ indexed: true }),
        },
        defaultOrder: [{ field: "rank", direction: "desc" }],
        hydrate: (values) => new RankedEntity(values.id, values.group, values.rank),
    })

    constructor(
        readonly id: string,
        readonly group: string,
        readonly rank: number,
    ) {}
}

class OtherEntity {
    static readonly storage = defineEntity<OtherEntity>()({
        schemaId: "other-entity",
        version: 1,
        columns: { id: column.text({ primary: true }) },
        hydrate: (values) => new OtherEntity(values.id),
    })

    constructor(readonly id: string) {}
}

describe("UnifyStore public schema and query API", () => {
    it("appends primary fields to configured default order for deterministic results", () => {
        expect(RankedEntity.storage.defaultOrder.map((order) => [order.field.name, order.direction])).toEqual([
            ["rank", "desc"],
            ["id", "asc"],
        ])
    })

    it("falls back to primary-key order when defaultOrder is omitted", () => {
        expect(OtherEntity.storage.defaultOrder.map((order) => [order.field.name, order.direction])).toEqual([["id", "asc"]])
    })

    it("includes normalized default order in the schema fingerprint", () => {
        class AscendingRankedEntity {
            static readonly storage = defineEntity<AscendingRankedEntity>()({
                schemaId: "ranked-entity",
                version: 1,
                columns: {
                    id: column.text({ primary: true }),
                    group: column.text({ indexed: true }),
                    rank: column.integer({ indexed: true }),
                },
                defaultOrder: [{ field: "rank", direction: "asc" }],
                hydrate: (values) => new AscendingRankedEntity(values.id, values.group, values.rank),
            })

            constructor(
                readonly id: string,
                readonly group: string,
                readonly rank: number,
            ) {}
        }

        expect(AscendingRankedEntity.storage.fingerprint).not.toBe(RankedEntity.storage.fingerprint)
    })

    it("builds a typed latest-per-group selection", () => {
        const fields = RankedEntity.storage.fields
        const selection = latestPerGroup({ groupBy: [fields.group], orderBy: [desc(fields.rank), asc(fields.id)] })
        expect(selection).toEqual({
            type: "latest-per-group",
            groupBy: [fields.group],
            orderBy: [desc(fields.rank), asc(fields.id)],
        })
        expectTypeOf(eq(fields.rank, 3).value).toEqualTypeOf<unknown>()
    })

    it("rejects incomplete or cross-schema latest-per-group selections", () => {
        const fields = RankedEntity.storage.fields
        expect(() => latestPerGroup({ groupBy: [], orderBy: [desc(fields.rank)] })).toThrow(/grouping field/i)
        expect(() => latestPerGroup({ groupBy: [fields.group], orderBy: [] })).toThrow(/ordering field/i)
        const untrustedCrossSchemaOrder = asc(OtherEntity.storage.fields.id) as unknown as UnifyStoreOrder<RankedEntity>
        expect(() => latestPerGroup<RankedEntity>({ groupBy: [fields.group], orderBy: [untrustedCrossSchemaOrder] })).toThrow(
            /cannot combine/i,
        )
    })

    it("keeps comparison values type-safe", () => {
        const fields = RankedEntity.storage.fields
        eq(fields.rank, 3)
        const assertComparisonTypeSafety = () => {
            // @ts-expect-error Numeric fields reject string values.
            eq(fields.rank, "3")
        }
        expectTypeOf(assertComparisonTypeSafety).toBeFunction()
    })

    it("keeps enum text and nullable column values narrow", () => {
        class StatusEntity {
            static readonly storage = defineEntity<StatusEntity>()({
                schemaId: "status-entity",
                version: 1,
                columns: {
                    id: column.text({ primary: true }),
                    status: column.enumText(["ready", "done"] as const),
                    note: column.text({ nullable: true }),
                },
                hydrate: (values) => new StatusEntity(values.id, values.status, values.note),
            })

            constructor(
                readonly id: string,
                readonly status: "ready" | "done",
                readonly note: string | null,
            ) {}
        }

        expect(StatusEntity.storage.columns.status.validate("ready")).toBe(true)
        expect(StatusEntity.storage.columns.status.validate("other")).toBe(false)
        expect(StatusEntity.storage.columns.note.validate(null)).toBe(true)
    })
})
