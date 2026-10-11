import { describe, expect, it, vi } from "vitest"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores/InMemoryRuntimeStores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { RetainedInputJournalBatch } from "./RetainedInputJournalBatch"

async function harness() {
    const payloads = new InMemoryTaskPayloadStore()
    const journal = new InMemoryConversationJournal()
    const originals: UserInputEnvelope[] = [
        { kind: "user_input", text: "RAW_A", admittedText: "ADMITTED_A", images: ["image-a"], authorizedTools: ["read_file"] },
        { kind: "user_input", text: "RAW_B", admittedText: "ADMITTED_B", files: ["file-b"] },
    ]
    const refs = await Promise.all(originals.map((payload) => payloads.put(encodeTaskPayload(payload))))
    const identity = {
        deliveryId: "delivery-1",
        entries: refs.map((payloadRef, index) => ({ entryId: `entry-${index}`, payloadRef })),
    }
    const stage = { ...identity, generation: 0, turnId: "turn-1", signal: new AbortController().signal }
    return { payloads, journal, originals, identity, stage, batches: new RetainedInputJournalBatch(payloads, journal) }
}

describe("RetainedInputJournalBatch", () => {
    it("writes the whole ordered batch as one atomic journal message with immutable raw authority refs", async () => {
        const h = await harness()
        const receipt = await h.batches.stage(h.stage)
        const entries = await h.journal.read()
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            operationId: "intake.retained:delivery-1",
            payloadRef: receipt.payloadRef,
            source: "intake",
        })
        const payload = decodeTaskPayload<UserInputEnvelope & { retainedInputBatch: typeof h.identity }>(
            await h.payloads.read(receipt.payloadRef),
        )
        expect(payload.text).toBe("RAW_A\n\nRAW_B")
        expect(payload.admittedText).toContain("ADMITTED_A")
        expect(payload.admittedText).toContain("ADMITTED_B")
        expect(payload.admittedText?.match(/sent by the user while work was in progress/g)).toHaveLength(1)
        expect(payload.admittedText?.match(/<user_message>/g)).toHaveLength(2)
        expect(payload).toMatchObject({ images: ["image-a"], files: ["file-b"], retainedInputBatch: h.identity })
        for (const [index, entry] of h.identity.entries.entries()) {
            expect(decodeTaskPayload(await h.payloads.read(entry.payloadRef))).toEqual(h.originals[index])
        }
    })

    it("keeps a retained input's resource in place and renders the batch exactly as its text form", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const image = {
            kind: "resource" as const,
            entityId: "img-1",
            nodeKind: "image" as const,
            ref: {
                resourceId: "00000000-0000-4000-8000-000000000001",
                expectedContentHash: "a".repeat(64),
                mediaType: "image/png",
                byteLength: 4,
                owner: { kind: "task" as const, taskId: "task-1" },
                generation: 1,
            },
            displayName: "shot.png",
        }
        const withImage: UserInputEnvelope = {
            kind: "user_input",
            text: "LOOK HERE",
            admittedText: "LOOK [image] HERE",
            admittedParts: [{ kind: "text", text: "LOOK " }, image, { kind: "text", text: " HERE" }],
        }
        const plain: UserInputEnvelope = { kind: "user_input", text: "PLAIN", admittedText: "PLAIN" }
        const refs = await Promise.all([withImage, plain].map((payload) => payloads.put(encodeTaskPayload(payload))))
        const entries = refs.map((payloadRef, index) => ({ entryId: `entry-${index}`, payloadRef }))
        const receipt = await new RetainedInputJournalBatch(payloads, journal).stage({
            deliveryId: "delivery-parts",
            entries,
            generation: 0,
            signal: new AbortController().signal,
        })

        const batch = decodeTaskPayload<UserInputEnvelope>(await payloads.read(receipt.payloadRef))
        const parts = batch.admittedParts ?? []
        expect(parts.filter((part) => part.kind === "resource")).toEqual([image])
        const asText = parts.map((part) => (part.kind === "text" ? part.text : "[image]")).join("")
        expect(asText).toBe(batch.admittedText)
    })

    it("writes no parts for a batch whose inputs carry no resource", async () => {
        const h = await harness()
        const receipt = await h.batches.stage(h.stage)
        const payload = decodeTaskPayload<UserInputEnvelope>(await h.payloads.read(receipt.payloadRef))
        expect(payload.admittedParts).toBeUndefined()
    })

    it("cannot leave a partial batch when a later payload fails to materialize", async () => {
        const h = await harness()
        const read = h.payloads.read.bind(h.payloads)
        vi.spyOn(h.payloads, "read").mockImplementation(async (ref) => {
            if (ref === h.identity.entries[1].payloadRef) throw new Error("second payload missing")
            return read(ref)
        })
        await expect(h.batches.stage(h.stage)).rejects.toThrow("second payload missing")
        expect(await h.journal.read()).toEqual([])
        await expect(h.batches.inspect(h.identity.deliveryId)).resolves.toEqual({ kind: "absent" })
    })

    it("recovers its durable receipt in a new instance without another append or changed causation", async () => {
        const h = await harness()
        const first = await h.batches.stage(h.stage)
        const reopened = new RetainedInputJournalBatch(h.payloads, h.journal)
        expect(await reopened.stage({ ...h.stage, generation: 1, turnId: "turn-restored" })).toEqual(first)
        expect(await h.journal.read()).toHaveLength(1)
        await expect(reopened.inspect(h.identity.deliveryId)).resolves.toEqual({ kind: "staged", receipt: first })
    })

    it("retracts all staged messages together and never reuses the old delivery identity", async () => {
        const h = await harness()
        await h.batches.stage(h.stage)
        await expect(h.batches.retract(h.identity)).resolves.toMatchObject({ kind: "retracted" })
        expect((await h.journal.project()).visibleMessages).toEqual([])
        expect(await new RetainedInputJournalBatch(h.payloads, h.journal).inspect(h.identity.deliveryId)).toMatchObject({
            kind: "retracted",
        })
        await h.batches.retract(h.identity)
        expect(await h.journal.read()).toHaveLength(2)
        await expect(h.batches.stage(h.stage)).rejects.toThrow("RetainedBatchAlreadyRetracted")
        await h.batches.stage({ ...h.stage, deliveryId: "delivery-next" })
        expect((await h.journal.project()).visibleMessages).toHaveLength(1)
    })

    it("refuses an old draft's changed fingerprint without retracting the real batch", async () => {
        const h = await harness()
        await h.batches.stage(h.stage)
        const changed = { ...h.identity, entries: [...h.identity.entries].reverse() }
        await expect(h.batches.stage({ ...h.stage, ...changed })).rejects.toThrow("RetainedBatchIdentityConflict")
        await expect(h.batches.retract(changed)).rejects.toThrow("RetainedBatchIdentityConflict")
        expect((await h.journal.project()).visibleMessages).toHaveLength(1)
    })

    it("keeps a durable stage visible when retraction fails instead of fabricating absence", async () => {
        const h = await harness()
        await h.batches.stage(h.stage)
        vi.spyOn(h.journal, "tombstone").mockRejectedValueOnce(new Error("rollback disk failure"))
        await expect(h.batches.retract(h.identity)).rejects.toThrow("rollback disk failure")
        await expect(h.batches.inspect(h.identity.deliveryId)).resolves.toMatchObject({ kind: "staged" })
        expect((await h.journal.project()).visibleMessages).toHaveLength(1)
    })

    it("reports lookup failures rather than negative evidence", async () => {
        const h = await harness()
        vi.spyOn(h.journal, "findByOperation").mockRejectedValueOnce(new Error("journal unavailable"))
        await expect(h.batches.inspect(h.identity.deliveryId)).rejects.toThrow("journal unavailable")
    })

    it("returns the durable receipt when cancel occurs in an append already in flight", async () => {
        const h = await harness()
        const controller = new AbortController()
        const append = h.journal.append.bind(h.journal)
        vi.spyOn(h.journal, "append").mockImplementation(async (input) => {
            const result = await append(input)
            controller.abort("cancel after append")
            return result
        })
        const receipt = await h.batches.stage({ ...h.stage, signal: controller.signal })
        expect(controller.signal.aborted).toBe(true)
        expect(await h.batches.inspect(h.identity.deliveryId)).toEqual({ kind: "staged", receipt })
        await h.batches.retract(h.identity)
        expect((await h.journal.project()).visibleMessages).toEqual([])
    })
})
