import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtlpBatchOutboxOptions, OtlpBatchOutboxRepository } from "../OtlpBatchOutboxRepository"

/** An hour boundary eight hours into a UTC day. */
const START = 1_800_000_000_000
const HOUR = 60 * 60_000

interface Item {
    readonly id: string
}

const isItem = (value: unknown): value is Item =>
    typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string"

function decode(body: string): { ids: string[]; dropped: number } {
    return JSON.parse(body)
}

describe("OtlpBatchOutboxRepository (TADR §2.4)", () => {
    let root: string
    let filePath: string

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otlp-outbox-"))
        filePath = path.join(root, "traces", "outbox.json")
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function outbox(overrides: Partial<OtlpBatchOutboxOptions<Item>> = {}): OtlpBatchOutboxRepository<Item> {
        return new OtlpBatchOutboxRepository<Item>(filePath, {
            channel: "traces",
            encode: (items, dropped) => JSON.stringify({ ids: items.map((item) => item.id), dropped }),
            isItem,
            maxItemsPerRequest: 3,
            maxPendingItems: 10,
            random: () => 0,
            ...overrides,
        })
    }

    const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }))

    it("replays an unsettled batch with the same request id and bytes, and forgets it once acknowledged", async () => {
        await outbox().append(items("a", "b"), START)

        const first = await outbox().claim("window-a", START)
        await outbox().settle("window-a", first!.requestId, { kind: "replay" }, START)
        const early = await outbox().claim("window-a", START + 1_000)
        const replayed = await outbox().claim("window-a", START + 31_000)
        await outbox().settle(
            "window-a",
            replayed!.requestId,
            { kind: "acknowledged", nextEligibleAt: START + HOUR },
            START + 31_000,
        )

        expect(early).toBeUndefined()
        expect(replayed).toEqual(first)
        expect(decode(first!.body)).toEqual({ ids: ["a", "b"], dropped: 0 })
        expect(await outbox().backlog()).toBe(0)
        // An acknowledged batch is gone: nothing is due, even after the gate.
        expect(await outbox().claim("window-a", START + HOUR + 10_000)).toBeUndefined()
    })

    it("starts no new batch before the gate the service named", async () => {
        const repository = outbox()
        await repository.append(items("a"), START)
        const first = await repository.claim("window-a", START)
        await repository.settle("window-a", first!.requestId, { kind: "acknowledged", nextEligibleAt: START + HOUR }, START)
        await repository.append(items("b"), START + 1_000)

        expect(await repository.claim("window-a", START + HOUR - 1)).toBeUndefined()
        const next = await repository.claim("window-a", START + HOUR + 2_000)
        expect(decode(next!.body).ids).toEqual(["b"])
    })

    it("drops items beyond the hourly admission and reports them with the next batch", async () => {
        const repository = outbox({ admission: { perHour: 2, perDay: 10 } })
        await repository.append(items("a", "b", "c"), START)
        await repository.append(items("d"), START + 1_000, 1)

        const batch = await repository.claim("window-a", START + 1_000)

        expect(decode(batch!.body)).toEqual({ ids: ["a", "b"], dropped: 3 })
        await repository.append(items("e"), START + HOUR)
        expect(await repository.backlog()).toBe(3)
    })

    it("sends one window per request when the channel says so", async () => {
        const repository = outbox({ maxItemsPerRequest: 1 })
        await repository.append(items("w1", "w2"), START)

        const batch = await repository.claim("window-a", START)

        expect(decode(batch!.body).ids).toEqual(["w1"])
        expect(await repository.backlog()).toBe(2)
    })

    it("splits a batch the service found too large and resends its first half at once", async () => {
        const repository = outbox()
        await repository.append(items("a", "b", "c"), START)
        const whole = await repository.claim("window-a", START)

        await repository.settle("window-a", whole!.requestId, { kind: "split" }, START)
        const half = await repository.claim("window-a", START)

        expect(half!.requestId).not.toBe(whole!.requestId)
        expect(decode(half!.body).ids).toEqual(["a", "b"])
        expect((await repository.read()).items).toEqual(items("c"))
    })

    it("lets only one window send a batch while its claim holds", async () => {
        const repository = outbox()
        await repository.append(items("a"), START)

        expect(await repository.claim("window-a", START)).toBeDefined()
        expect(await repository.claim("window-b", START + 1_000)).toBeUndefined()
    })

    it("forgets the items on withdrawn consent but keeps the server gate", async () => {
        const repository = outbox()
        await repository.append(items("a"), START)
        const batch = await repository.claim("window-a", START)
        await repository.settle("window-a", batch!.requestId, { kind: "acknowledged", nextEligibleAt: START + HOUR }, START)
        await repository.append(items("b"), START)

        await repository.clear()
        await repository.append(items("c"), START + 1_000)

        expect((await repository.read()).items).toEqual(items("c"))
        expect(await repository.claim("window-a", START + 1_000)).toBeUndefined()
    })

    it("drops a batch that stayed unsettled for a day and reports it", async () => {
        const repository = outbox()
        await repository.append(items("a", "b"), START)
        const batch = await repository.claim("window-a", START)

        await repository.settle("window-a", batch!.requestId, { kind: "replay" }, START + 24 * HOUR)
        await repository.append(items("c"), START + 24 * HOUR)
        const next = await repository.claim("window-a", START + 24 * HOUR + 10 * 60_000)

        expect(decode(next!.body)).toEqual({ ids: ["c"], dropped: 2 })
    })

    it("reads a document holding an item it cannot validate as empty", async () => {
        await outbox().append(items("a"), START)
        const document = JSON.parse(await fs.readFile(filePath, "utf8"))
        await fs.writeFile(filePath, JSON.stringify({ ...document, items: [{ id: 7 }] }))
        await fs.rm(`${filePath}.bak`, { force: true })

        expect((await outbox().read()).items).toEqual([])
    })
})
