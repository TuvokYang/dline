import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { column, defineEntity } from "../../api/EntitySchema"
import { BufferedUnifyStore } from "../../core/BufferedUnifyStore"
import { MemoryUnifyStoreBackend } from "../fixtures/MemoryUnifyStore"

interface TestItem {
    ts: number
    value: string
}

class BufferedRow {
    static readonly storage = defineEntity<BufferedRow>()({
        schemaId: "buffered-unify-store-test",
        version: 1,
        columns: {
            rowId: column.text({ primary: true }),
            ordinal: column.integer({ indexed: true }),
            timestamp: column.integer({ indexed: true }),
            payload: column.json<TestItem>({ validate: isTestItem }),
        },
        defaultOrder: [{ field: "ordinal", direction: "asc" }],
        hydrate: (values) => new BufferedRow(values.rowId, values.ordinal, values.timestamp, values.payload),
    })

    constructor(
        readonly rowId: string,
        readonly ordinal: number,
        readonly timestamp: number,
        readonly payload: TestItem,
    ) {}
}

const backend = new MemoryUnifyStoreBackend()

async function open(location: string, options?: { ensureUniqueAppendTimestamp?: boolean }) {
    const database = await backend.open(location)
    const store = await database.openStore(BufferedRow)
    const buffered = await BufferedUnifyStore.open({
        store,
        mapping: {
            ordinal: BufferedRow.storage.fields.ordinal,
            timestamp: BufferedRow.storage.fields.timestamp,
            toItem: (row) => structuredClone(row.payload),
            toEntity: (item, ordinal) => new BufferedRow(randomUUID(), ordinal, item.ts, structuredClone(item)),
        },
        bufferOptions: {
            flushIntervalMs: 60_000,
            subscriptionKey: location,
            ensureUniqueAppendTimestamp: options?.ensureUniqueAppendTimestamp,
            acceptInitialItem: (item) => item.ts > 0,
        },
    })
    const originalClose = buffered.close.bind(buffered)
    let closePromise: Promise<void> | undefined
    buffered.close = () => {
        closePromise ??= originalClose().then(() => database.close())
        return closePromise
    }
    return buffered
}

describe("BufferedUnifyStore", () => {
    it("keeps staged writes local until flush", async () => {
        const location = `buffered-local-${randomUUID()}`
        const writer = await open(location)
        const observer = await open(location)
        try {
            await writer.append({ ts: 100, value: "staged" })
            expect(writer.getAll()).toEqual([{ ts: 100, value: "staged" }])
            await observer.reload(true)
            expect(observer.getAll()).toEqual([])
            await writer.flush()
            await observer.reload(true)
            expect(observer.getAll()).toEqual([{ ts: 100, value: "staged" }])
        } finally {
            await Promise.all([writer.close(), observer.close()])
        }
    })

    it("preserves another handle's committed tail during stale flush", async () => {
        const location = `buffered-merge-${randomUUID()}`
        const seed = await open(location)
        await seed.replaceAll([{ ts: 100, value: "seed" }])
        await seed.close()
        const stale = await open(location)
        const active = await open(location)
        try {
            await stale.stagePatchAt(0, { value: "updated" })
            await active.append({ ts: 200, value: "tail" })
            await active.flush()
            await stale.flush()
            const reader = await open(location)
            try {
                expect(reader.getAll()).toEqual([
                    { ts: 100, value: "updated" },
                    { ts: 200, value: "tail" },
                ])
            } finally {
                await reader.close()
            }
        } finally {
            await Promise.all([stale.close(), active.close()])
        }
    })

    it("supports durable structural mutations and destructive reload", async () => {
        const location = `buffered-structural-${randomUUID()}`
        const store = await open(location)
        const observer = await open(location)
        try {
            await store.replaceAll([
                { ts: 100, value: "a" },
                { ts: 300, value: "c" },
            ])
            await store.insertAt(1, { ts: 200, value: "b" })
            await observer.reload(true)
            expect(observer.getAll().map(({ value }) => value)).toEqual(["a", "b", "c"])
            await store.append({ ts: 400, value: "discarded" })
            await store.reload(true)
            expect(store.getAll().map(({ value }) => value)).toEqual(["a", "b", "c"])
        } finally {
            await Promise.all([store.close(), observer.close()])
        }
    })

    it("allocates unique timestamps across concurrent appenders", async () => {
        const location = `buffered-unique-${randomUUID()}`
        const left = await open(location, { ensureUniqueAppendTimestamp: true })
        const right = await open(location, { ensureUniqueAppendTimestamp: true })
        try {
            await left.append({ ts: 100, value: "left" })
            await right.append({ ts: 100, value: "right" })
            await Promise.all([left.flush(), right.flush()])
            const reader = await open(location, { ensureUniqueAppendTimestamp: true })
            try {
                expect(
                    reader
                        .getAll()
                        .map(({ value }) => value)
                        .sort(),
                ).toEqual(["left", "right"])
                expect(new Set(reader.getAll().map(({ ts }) => ts)).size).toBe(2)
            } finally {
                await reader.close()
            }
        } finally {
            await Promise.all([left.close(), right.close()])
        }
    })

    it("closes idempotently after admitted writes and rejects later writes", async () => {
        const store = await open(`buffered-close-${randomUUID()}`)
        const admitted = store.append({ ts: 100, value: "admitted" })
        const firstClose = store.close()
        const secondClose = store.close()
        expect(secondClose).toBe(firstClose)
        await Promise.all([admitted, firstClose])
        await expect(store.append({ ts: 200, value: "rejected" })).rejects.toThrow(/closed/i)
    })
})

function isTestItem(value: unknown): value is TestItem {
    if (typeof value !== "object" || value === null) return false
    const item = value as Partial<TestItem>
    return typeof item.ts === "number" && Number.isFinite(item.ts) && typeof item.value === "string"
}
