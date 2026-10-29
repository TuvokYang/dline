import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { openBufferedJsonlStore } from "../../jsonl/JsonlUnifyStore"

/**
 * Regression guard for the cost of opening a large message history.
 *
 * The committed baseline used to be built with `structuredClone` per entry, so
 * opening a task copied its whole history a second time before anything could be
 * shown. For a long conversation that dominated resume time and doubled resident
 * memory. The baseline is read-only, so entries are now shared by reference.
 */

interface StoredMessage {
    ts: number
    role: string
    text: string
}

const ENTRY_COUNT = 4_000
const roots: string[] = []

/**
 * Create an isolated directory for one store fixture.
 *
 * @returns The absolute path of the fixture file.
 */
function createFixturePath(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "dline-buffered-store-"))
    roots.push(root)
    return path.join(root, "messages.jsonl")
}

/**
 * Build a message whose payload is large enough that deep cloning is measurable.
 *
 * @param index The message ordinal, also used as its timestamp.
 * @returns The stored message.
 */
function createMessage(index: number): StoredMessage {
    return { ts: index + 1, role: index % 2 === 0 ? "user" : "assistant", text: "x".repeat(512) }
}

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("BufferedUnifyStore load cost", () => {
    it("shares committed entries with the caller instead of deep copying them", async () => {
        const filePath = createFixturePath()
        const store = await openBufferedJsonlStore<StoredMessage>(filePath, { schemaId: "load-cost" })
        await store.mutate(() => Array.from({ length: ENTRY_COUNT }, (_, index) => createMessage(index)))

        const reopened = await openBufferedJsonlStore<StoredMessage>(filePath, { schemaId: "load-cost" })
        const items = reopened.getAll()

        expect(items).toHaveLength(ENTRY_COUNT)
        expect(items[0].text).toHaveLength(512)
        expect(items[ENTRY_COUNT - 1].ts).toBe(ENTRY_COUNT)
    })

    it("keeps an append cheap after loading a large history", async () => {
        const filePath = createFixturePath()
        const seed = await openBufferedJsonlStore<StoredMessage>(filePath, { schemaId: "load-cost" })
        await seed.mutate(() => Array.from({ length: ENTRY_COUNT }, (_, index) => createMessage(index)))

        const store = await openBufferedJsonlStore<StoredMessage>(filePath, { schemaId: "load-cost" })
        const appended: StoredMessage = { ts: ENTRY_COUNT + 1, role: "user", text: "appended" }
        await store.mutate((current) => [...current, appended])

        const reloaded = await openBufferedJsonlStore<StoredMessage>(filePath, { schemaId: "load-cost" })
        const items = reloaded.getAll()

        // The retained prefix must survive an append that no longer re-serializes it.
        expect(items).toHaveLength(ENTRY_COUNT + 1)
        expect(items[0]).toEqual(createMessage(0))
        expect(items[ENTRY_COUNT]).toEqual(appended)
    })

    it("still detects a modified entry rather than trusting the shared baseline", async () => {
        const filePath = createFixturePath()
        const seed = await openBufferedJsonlStore<StoredMessage>(filePath, { schemaId: "load-cost" })
        await seed.mutate(() => Array.from({ length: 8 }, (_, index) => createMessage(index)))

        const store = await openBufferedJsonlStore<StoredMessage>(filePath, { schemaId: "load-cost" })
        await store.mutate((current) => current.map((item, index) => (index === 2 ? { ...item, text: "edited" } : item)))

        const reloaded = await openBufferedJsonlStore<StoredMessage>(filePath, { schemaId: "load-cost" })
        const items = reloaded.getAll()

        expect(items[2].text).toBe("edited")
        expect(items[1].text).toHaveLength(512)
    })
})
