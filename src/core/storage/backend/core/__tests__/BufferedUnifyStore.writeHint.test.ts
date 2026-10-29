import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { MemoryUnifyStoreBackend } from "../../__tests__/fixtures/MemoryUnifyStore"
import { column, defineEntity } from "../../api/EntitySchema"
import type { UnifyStore, UnifyStoreWriteHint } from "../../api/UnifyStore"
import type { BufferedTailReplacement } from "../BufferedUnifyStore"
import { BufferedUnifyStore } from "../BufferedUnifyStore"

interface Item {
    ts: number
    value: string
}

function isItem(value: unknown): value is Item {
    return typeof value === "object" && value !== null && typeof (value as Item).ts === "number"
}

class HintRow {
    static readonly storage = defineEntity<HintRow>()({
        schemaId: "buffered-write-hint-test",
        version: 1,
        columns: {
            ordinal: column.integer({ primary: true }),
            timestamp: column.integer({ indexed: true }),
            payload: column.json<Item>({ validate: isItem }),
        },
        defaultOrder: [{ field: "ordinal", direction: "asc" }],
        hydrate: (values) => new HintRow(values.ordinal, values.timestamp, values.payload),
    })

    constructor(
        readonly ordinal: number,
        readonly timestamp: number,
        readonly payload: Item,
    ) {}
}

interface Observed {
    readonly hints: (UnifyStoreWriteHint | undefined)[]
    queries: number
}

/** Records every replaceAll hint and counts reads, delegating the writes unchanged. */
function observing(store: UnifyStore<HintRow>, observed: Observed): UnifyStore<HintRow> {
    return {
        query: (query) => {
            observed.queries++
            return store.query(query)
        },
        insert: (records) => store.insert(records),
        upsert: (records) => store.upsert(records),
        replaceAll: (records, hint) => {
            observed.hints.push(hint)
            return store.replaceAll(records)
        },
        transaction: (operation) =>
            store.transaction((transaction) =>
                operation({
                    query: (query) => {
                        observed.queries++
                        return transaction.query(query)
                    },
                    insert: (records) => transaction.insert(records),
                    upsert: (records) => transaction.upsert(records),
                    replaceAll: (records, hint) => {
                        observed.hints.push(hint)
                        return transaction.replaceAll(records)
                    },
                }),
            ),
        stats: () => store.stats(),
        close: () => store.close(),
    }
}

const backend = new MemoryUnifyStoreBackend()

function items(count: number): Item[] {
    return Array.from({ length: count }, (_, index) => ({ ts: 100 + index, value: `v${index}` }))
}

async function open(
    options: {
        replaceTail?: (replacement: BufferedTailReplacement<Item>) => Promise<boolean>
        /** Hand out the stored payload by reference, as the UI message mapping does. */
        aliasPayload?: boolean
    } = {},
) {
    const database = await backend.open(`write-hint-${randomUUID()}`)
    const raw = await database.openStore(HintRow)
    const observed: Observed = { hints: [], queries: 0 }
    const buffered = await BufferedUnifyStore.open({
        store: observing(raw, observed),
        mapping: {
            ordinal: HintRow.storage.fields.ordinal,
            timestamp: HintRow.storage.fields.timestamp,
            toItem: (row) => (options.aliasPayload ? row.payload : structuredClone(row.payload)),
            toEntity: (item, ordinal) => new HintRow(ordinal, item.ts, options.aliasPayload ? item : structuredClone(item)),
        },
        bufferOptions: {
            flushIntervalMs: 60_000,
            subscriptionKey: `write-hint-${randomUUID()}`,
            acceptInitialItem: (item) => item.ts > 0,
            ...(options.replaceTail ? { replaceTail: options.replaceTail, replaceTailIsAtomic: false } : {}),
        },
    })
    const seed = async (seeded: readonly Item[]) => {
        await buffered.replaceAll(seeded)
        observed.hints.length = 0
        observed.queries = 0
    }
    return { buffered, raw, observed, seed }
}

describe("BufferedUnifyStore replaceAll write hint", () => {
    it("passes the first index whose row differs from the preimage read by mutate, with no extra read", async () => {
        const { buffered, observed, seed } = await open()
        await seed(items(5))

        await buffered.mutate((current) => current.map((item, index) => (index === 2 ? { ...item, value: "edited" } : item)))

        expect(observed.hints).toEqual([{ firstChangedIndex: 2 }])
        expect(observed.queries).toBe(1)
        await buffered.close()
    })

    it("finds an in-place edit of an early row when the mapping aliases stored payloads", async () => {
        const { buffered, observed, seed } = await open({ aliasPayload: true })
        await seed(items(4))

        await buffered.mutate((current) => {
            current[0].value = "edited first turn"
            return current
        })

        expect(observed.hints).toEqual([{ firstChangedIndex: 0 }])
        await buffered.close()
    })

    it("reports an unchanged prefix for truncation, a prepend as 0 and no change as the length", async () => {
        const { buffered, observed, seed } = await open()
        await seed(items(5))

        await buffered.truncateAt(3)
        await buffered.insertAt(0, { ts: 50, value: "first" })
        await buffered.mutate((current) => current)

        expect(observed.hints).toEqual([{ firstChangedIndex: 3 }, { firstChangedIndex: 0 }, { firstChangedIndex: 4 }])
        await buffered.close()
    })

    it("compares against the rows another writer committed, not the local baseline", async () => {
        const { buffered, raw, observed, seed } = await open()
        await seed(items(4))
        // Another handle rewrites row 1 behind the buffered store's back.
        await raw.replaceAll(
            items(4).map((item, ordinal) => new HintRow(ordinal, item.ts, ordinal === 1 ? { ...item, value: "foreign" } : item)),
        )

        await buffered.mutate((current) => current.map((item, index) => (index === 3 ? { ...item, value: "mine" } : item)))

        expect(observed.hints).toEqual([{ firstChangedIndex: 3 }])
        await buffered.close()
    })

    it("passes the merge's first difference from the committed rows when committing staged edits", async () => {
        const { buffered, observed, seed } = await open()
        await seed(items(4))

        await buffered.stageUpdateAt(2, { ts: 102, value: "staged" })
        await buffered.flush()

        expect(observed.hints).toEqual([{ firstChangedIndex: 2 }])
        expect(observed.queries).toBe(1)
        await buffered.close()
    })

    it("passes 0 when it rewrites memory after an interrupted tail write", async () => {
        let failTail = true
        const { buffered, observed, seed } = await open({
            replaceTail: async () => {
                if (failTail) throw new Error("tail write cut short")
                return false
            },
        })
        await seed(items(3))

        await buffered.stageUpdateAt(2, { ts: 102, value: "staged" })
        await expect(buffered.flush()).rejects.toThrow("tail write cut short")
        failTail = false
        await buffered.flush()

        expect(observed.hints).toEqual([{ firstChangedIndex: 0 }])
        await buffered.close()
    })
})
