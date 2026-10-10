import { describe, expect, it } from "vitest"
import { column, defineEntity } from "../../api/EntitySchema"
import { asc, desc, gte, latestPerGroup } from "../../api/UnifyStoreQuery"
import { normalizeUnifyStoreQuery } from "../../core/UnifyStoreQueryEvaluator"
import { compileSqliteQuery } from "../../sqlite/SqliteQueryCompiler"

class QueryEntity {
    static readonly storage = defineEntity<QueryEntity>()({
        schemaId: "sqlite-query-compiler-test",
        version: 1,
        columns: {
            id: column.text({ primary: true }),
            group: column.text({ indexed: true }),
            sortKey: column.integer({ indexed: true }),
            revision: column.integer({ indexed: true }),
            value: column.text(),
        },
        defaultOrder: [{ field: "sortKey", direction: "asc" }],
        hydrate: (values) => new QueryEntity(values.id, values.group, values.sortKey, values.revision, values.value),
    })

    constructor(
        readonly id: string,
        readonly group: string,
        readonly sortKey: number,
        readonly revision: number,
        readonly value: string,
    ) {}
}

describe("SqliteQueryCompiler", () => {
    it("compiles schema default order with deterministic primary-key tie-breaker", () => {
        const compiled = compileSqliteQuery(QueryEntity.storage, normalizeUnifyStoreQuery(QueryEntity.storage))
        expect(compiled.sql).toContain('ORDER BY "sortKey" ASC, "id" ASC')
        expect(compiled.bindings).toEqual([])
    })

    it("compiles where, latest-per-group, final order and limit in the required execution order", () => {
        const fields = QueryEntity.storage.fields
        const compiled = compileSqliteQuery(
            QueryEntity.storage,
            normalizeUnifyStoreQuery(QueryEntity.storage, {
                where: gte(fields.sortKey, 10),
                select: latestPerGroup({ groupBy: [fields.group], orderBy: [desc(fields.revision)] }),
                orderBy: [asc(fields.sortKey)],
                limit: 2,
            }),
        )

        expect(compiled.sql).toContain(
            'ROW_NUMBER() OVER (PARTITION BY "group" ORDER BY "revision" DESC, "id" ASC) AS "__unify_rank"',
        )
        expect(compiled.sql).toMatch(/ROW_NUMBER\(\).* FROM .* WHERE "sortKey" >= \?\) SELECT/s)
        expect(compiled.sql).toContain('WHERE "__unify_rank" = 1 ORDER BY "sortKey" ASC LIMIT ?')
        expect(compiled.bindings).toEqual([10, 2])
    })
})
