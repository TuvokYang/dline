import { describe, expect, it } from "vitest"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
    ProviderDraftEnvelope,
    ProviderFinalEnvelope,
    ToolInvocationEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import { ProductionProviderAdapter } from "./ProductionProviderAdapter"

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
        const invocationRef = storedFinal.turnPlan.blocks[0].invocationRef
        expect(decodeTaskPayload<ToolInvocationEnvelope>(await payloads.read(invocationRef))).toMatchObject({
            kind: "tool_invocation",
            toolName: "read_file",
        })
    })
})
