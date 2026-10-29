import { describe, expect, it } from "vitest"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
    ProviderDraftEnvelope,
    ProviderFinalEnvelope,
    ToolInvocationEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import { ProductionProviderAdapter, type ProductionProviderChunk } from "./ProductionProviderAdapter"

class MemoryPayloads implements TaskPayloadStore {
    private sequence = 0
    private readonly values = new Map<string, Uint8Array>()

    get storedCount(): number {
        return this.values.size
    }

    async put(payload: Uint8Array): Promise<string> {
        const ref = `payload:${++this.sequence}`
        this.values.set(ref, payload)
        return ref
    }
    async read(ref: string): Promise<Uint8Array> {
        const value = this.values.get(ref)
        if (!value) throw new Error(`MissingPayload:${ref}`)
        return value
    }
}

async function runFinal(chunk: Extract<ProductionProviderChunk, { kind: "final" }>) {
    const payloads = new MemoryPayloads()
    const draftRef = await payloads.put(
        encodeTaskPayload<ProviderDraftEnvelope>({
            kind: "provider_draft",
            admittedEntryIds: ["entry-1"],
            inputPayloadRefs: ["input:1"],
        }),
    )
    const adapter = new ProductionProviderAdapter({
        payloads,
        service: {
            async *start() {
                yield chunk
            },
        },
    })
    const output = []
    for await (const value of adapter.start({ draftRef, signal: new AbortController().signal })) output.push(value)
    const final = output[0]
    if (final?.kind !== "final") throw new Error("expected final")
    return {
        adapter,
        final,
        storedFinal: decodeTaskPayload<ProviderFinalEnvelope>(await payloads.read(final.payloadRef)),
    }
}

describe("ProductionProviderAdapter", () => {
    it("keeps partial content transient and materializes final and tool invocation payload refs", async () => {
        const payloads = new MemoryPayloads()
        const draft: ProviderDraftEnvelope = {
            kind: "provider_draft",
            admittedEntryIds: ["entry-1"],
            inputPayloadRefs: ["input:1"],
        }
        const draftRef = await payloads.put(encodeTaskPayload(draft))
        const adapter = new ProductionProviderAdapter({
            payloads,
            service: {
                async *start() {
                    yield { kind: "partial" as const, transientId: "stream-1", text: "hel" }
                    yield {
                        kind: "final" as const,
                        turnId: "turn-1",
                        transientId: "stream-1",
                        text: "hello",
                        modelInfo: { modelId: "source-model", providerId: "anthropic", mode: "act" as const },
                        mode: "serial" as const,
                        blocks: [
                            {
                                blockId: "block-1",
                                attempt: "attempt-1",
                                index: 0,
                                lanes: ["fs"],
                                turnEnding: false,
                                invocation: {
                                    kind: "tool_invocation" as const,
                                    toolName: "read_file",
                                    input: { path: "a.ts" },
                                    functionId: "function-1",
                                    dlineTid: "block-1",
                                    presentationId: 1,
                                    isNativeToolCall: false,
                                },
                                approval: { kind: "none" as const },
                            },
                        ],
                    }
                },
            },
        })

        const chunks = []
        for await (const chunk of adapter.start({ draftRef, signal: new AbortController().signal })) chunks.push(chunk)
        expect(chunks).toHaveLength(2)
        expect(chunks[0]).toMatchObject({ kind: "partial", transientId: "stream-1", text: "hel" })
        expect(chunks[0]).not.toHaveProperty("payloadRef")
        // Draft, tool invocation and final are durable; the partial is not.
        expect(payloads.storedCount).toBe(3)
        const final = chunks[1]
        if (final.kind !== "final") throw new Error("expected final")
        const storedFinal = decodeTaskPayload<ProviderFinalEnvelope>(await payloads.read(final.payloadRef))
        // The producer is durable with the reply, so a restart still knows the turn's model.
        expect(storedFinal.modelInfo).toEqual({ modelId: "source-model", providerId: "anthropic", mode: "act" })
        expect(storedFinal.turnPlan.plainTextWarning).toBeUndefined()
        await expect(adapter.recoverFinal(final.payloadRef)).resolves.toEqual({
            modelInfo: { modelId: "source-model", providerId: "anthropic", mode: "act" },
            turnPlan: storedFinal.turnPlan,
        })
        const invocationRef = storedFinal.turnPlan.blocks[0].invocationRef
        expect(decodeTaskPayload<ToolInvocationEnvelope>(await payloads.read(invocationRef))).toMatchObject({
            kind: "tool_invocation",
            toolName: "read_file",
        })
    })

    it("warns durably only for plain text without a call and restores it with model identity", async () => {
        const pure = await runFinal({
            kind: "final",
            turnId: "turn-pure",
            text: "plain answer",
            modelInfo: { modelId: "model-pure", providerId: "openai", mode: "act" },
            mode: "serial",
            blocks: [],
        })
        expect(pure.final.turnPlan.plainTextWarning).toBe("text_only")
        expect(pure.storedFinal.turnPlan.plainTextWarning).toBe("text_only")
        await expect(pure.adapter.recoverFinal(pure.final.payloadRef)).resolves.toEqual({
            turnPlan: pure.storedFinal.turnPlan,
            modelInfo: { modelId: "model-pure", providerId: "openai", mode: "act" },
        })

        const mixed = await runFinal({
            kind: "final",
            turnId: "turn-mixed",
            text: "prose before a tool",
            modelInfo: { modelId: "model-mixed", providerId: "anthropic", mode: "plan" },
            modelCustom: true,
            mode: "serial",
            blocks: [
                {
                    blockId: "block-mixed",
                    attempt: "attempt-mixed",
                    index: 0,
                    lanes: [],
                    turnEnding: false,
                    invocation: {
                        kind: "tool_invocation",
                        toolName: "read_file",
                        input: { path: "a.ts" },
                        functionId: "function-mixed",
                        dlineTid: "block-mixed",
                        presentationId: 2,
                        isNativeToolCall: false,
                    },
                    approval: { kind: "none" },
                },
            ],
        })
        // Prose beside a call is an allowed reply shape, not a warning.
        expect(mixed.final.turnPlan.plainTextWarning).toBeUndefined()
        expect(mixed.storedFinal.turnPlan.plainTextWarning).toBeUndefined()
        // Whether the model is custom only feeds live telemetry; it is not durable turn state.
        expect(mixed.final.modelCustom).toBe(true)
        expect(mixed.storedFinal).not.toHaveProperty("modelCustom")
        await expect(mixed.adapter.recoverFinal(mixed.final.payloadRef)).resolves.toEqual({
            turnPlan: mixed.storedFinal.turnPlan,
            modelInfo: { modelId: "model-mixed", providerId: "anthropic", mode: "plan" },
        })
    })
})
