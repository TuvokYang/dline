import { describe, expect, it } from "vitest"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { CompactionContextEnvelope, CompactionResultEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { CompactionReviewWithdrawnError, ProductionCompactionAdapter } from "./ProductionCompactionAdapter"

class MemoryPayloads implements TaskPayloadStore {
    private sequence = 0
    private readonly values = new Map<string, Uint8Array>()
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

describe("ProductionCompactionAdapter", () => {
    it("decodes context and materializes the compaction result", async () => {
        const payloads = new MemoryPayloads()
        const context: CompactionContextEnvelope = { kind: "compaction_context", context: { messages: 3 } }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async ({ context: decoded }) => ({ summary: decoded }) },
        })
        const result = await adapter.run({
            compactionId: "compact-1",
            attempt: "attempt-1",
            contextRef,
            signal: new AbortController().signal,
            publish: () => undefined,
        })
        expect(decodeTaskPayload<CompactionResultEnvelope>(await payloads.read(result.resultRef))).toEqual({
            kind: "compaction_result",
            result: { summary: { messages: 3 } },
        })
    })

    it("settles the Chat Restore owner before summary generation and falls back to the card on failure", async () => {
        const payloads = new MemoryPayloads()
        const context: CompactionContextEnvelope = { kind: "compaction_context", context: { messages: 3 } }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const order: string[] = []
        const landed: unknown[] = []
        const run = (beforeCompaction: () => Promise<"checkpoint_row" | "card_fallback">) =>
            new ProductionCompactionAdapter({
                payloads,
                service: {
                    run: async () => {
                        order.push("summary")
                        return { summary: "condensed" }
                    },
                },
                checkpoint: { beforeCompaction },
                landing: { land: async (input) => void landed.push(input) },
            }).run({
                compactionId: "compact-1",
                attempt: "attempt-1",
                contextRef,
                signal: new AbortController().signal,
                publish: () => undefined,
            })

        await run(async () => {
            order.push("checkpoint")
            return "checkpoint_row"
        })
        expect(order).toEqual(["checkpoint", "summary"])
        expect(landed.at(-1)).toMatchObject({ restoreDisposition: "checkpoint_row" })

        order.length = 0
        landed.length = 0
        await expect(
            run(async () => {
                throw new Error("checkpoint row unavailable")
            }),
        ).resolves.toMatchObject({ resultRef: expect.any(String) })
        expect(order).toEqual(["summary"])
        expect(landed.at(-1)).toMatchObject({ restoreDisposition: "card_fallback" })
    })

    it("truncates through the pairing-safe canonical truncation port without asking the provider or reviewer", async () => {
        const payloads = new MemoryPayloads()
        const span = { from: { seq: 2 }, to: { seq: 4 } }
        const context: CompactionContextEnvelope = {
            kind: "compaction_context",
            mode: "force_truncate",
            trigger: "manual",
            span,
            context: { sourceHistory: [] },
        }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const landed: unknown[] = []
        const truncated: Array<{ readonly notice: string; readonly signal?: AbortSignal }> = []
        let asked = 0
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: {
                run: async () => {
                    asked++
                    return { summary: "a summary nobody asked for" }
                },
            },
            review: {
                review: async () => {
                    asked++
                    return { action: "accept" }
                },
            },
            truncation: {
                truncate: async (input) => {
                    truncated.push(input)
                    return { seq: 7 }
                },
            },
            canonicalLanding: { land: async (input) => void landed.push(input) },
            landing: { land: async (input) => void landed.push(input) },
        })

        await adapter.run({
            compactionId: "truncate-1",
            attempt: "attempt-1",
            contextRef,
            signal: new AbortController().signal,
            publish: () => undefined,
        })

        expect(asked).toBe(0)
        expect(landed).toHaveLength(0)
        expect(truncated).toEqual([
            {
                notice: expect.stringContaining("[NOTE] Some previous conversation history with the user has been removed"),
                signal: expect.any(AbortSignal),
            },
        ])
    })

    it("does not write a completed card when cancellation wins during canonical landing", async () => {
        const payloads = new MemoryPayloads()
        const context: CompactionContextEnvelope = {
            kind: "compaction_context",
            span: { from: { seq: 2 }, to: { seq: 4 } },
            context: { sourceHistory: [] },
        }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const controller = new AbortController()
        const presented: unknown[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async () => ({ summary: "condensed" }) },
            canonicalLanding: {
                land: async () => {
                    controller.abort("compaction_cancelled")
                },
            },
            landing: { land: async (input) => void presented.push(input) },
        })

        await expect(
            adapter.run({
                compactionId: "compact-1",
                attempt: "attempt-1",
                contextRef,
                signal: controller.signal,
                publish: () => undefined,
            }),
        ).rejects.toBe("compaction_cancelled")
        expect(presented).toEqual([])
    })

    it("commits completion when cancellation arrives during the final presentation write", async () => {
        const payloads = new MemoryPayloads()
        const context: CompactionContextEnvelope = {
            kind: "compaction_context",
            span: { from: { seq: 2 }, to: { seq: 4 } },
            context: { sourceHistory: [] },
        }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const controller = new AbortController()
        const presented: unknown[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async () => ({ summary: "condensed" }) },
            landing: {
                land: async (input) => {
                    presented.push(input)
                    controller.abort("compaction_cancelled")
                },
            },
        })

        await expect(
            adapter.run({
                compactionId: "compact-1",
                attempt: "attempt-1",
                contextRef,
                signal: controller.signal,
                publish: () => undefined,
            }),
        ).resolves.toMatchObject({ resultRef: expect.any(String), completionCommitted: true })
        expect(presented).toHaveLength(1)
    })

    it("lands the span the request fixed, not whatever the conversation holds when the summary returns", async () => {
        const payloads = new MemoryPayloads()
        const span = { from: { seq: 2 }, to: { seq: 4 } }
        const context: CompactionContextEnvelope = { kind: "compaction_context", span, context: { sourceHistory: [] } }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const landed: unknown[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async () => ({ summary: "condensed" }) },
            landing: { land: async (input) => void landed.push(input) },
        })

        await adapter.run({
            compactionId: "compact-1",
            attempt: "attempt-1",
            contextRef,
            signal: new AbortController().signal,
            publish: () => undefined,
        })

        // The run's signal travels with the landing so its commit point can refuse a stopped run.
        expect(landed).toEqual([
            {
                compactionId: "compact-1",
                attempt: "attempt-1",
                summary: "condensed",
                span,
                signal: expect.any(AbortSignal),
                restoreDisposition: "card_fallback",
            },
        ])
    })

    // The run stopped once the oldest turns were summarized: the newer turns and
    // the reply the span ended on are still where the conversation left off, so
    // the summary lands on the covered part only and carries no reply.
    it("lands a summary that covered only the oldest turns on those turns alone", async () => {
        const payloads = new MemoryPayloads()
        const span = { from: { seq: 2 }, to: { seq: 9 } }
        const context: CompactionContextEnvelope = {
            kind: "compaction_context",
            span,
            continuation: { text: "latest reply" },
            trigger: "automatic",
            context: { sourceHistory: [] },
        }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const landed: unknown[] = []
        const triggers: unknown[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: {
                run: async ({ trigger }) => {
                    triggers.push(trigger)
                    return { summary: "oldest turns", coveredThrough: 5 }
                },
            },
            landing: { land: async (input) => void landed.push(input) },
        })

        await adapter.run({
            compactionId: "compact-1",
            attempt: "attempt-1",
            contextRef,
            signal: new AbortController().signal,
            publish: () => undefined,
        })

        expect(triggers).toEqual(["automatic"])
        expect(landed).toEqual([
            {
                compactionId: "compact-1",
                attempt: "attempt-1",
                summary: "oldest turns",
                coveredThrough: 5,
                span: { from: { seq: 2 }, to: { seq: 5 } },
                signal: expect.any(AbortSignal),
                restoreDisposition: "card_fallback",
            },
        ])
    })

    it("lands the user's answer with the call a partial summary ended on, and replays the answer", async () => {
        const payloads = new MemoryPayloads()
        const span = { from: { seq: 1 }, to: { seq: 11 } }
        const context: CompactionContextEnvelope = {
            kind: "compaction_context",
            span,
            replies: [
                { callSeq: 3, replySeq: 6, continuation: { text: "answer to turn A" } },
                { callSeq: 8, replySeq: 11, continuation: { text: "answer to turn B" } },
            ],
            trigger: "automatic",
            context: { sourceHistory: [] },
        }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const landed: unknown[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async () => ({ summary: "turn A", coveredThrough: 3 }) },
            landing: { land: async (input) => void landed.push(input) },
        })

        await adapter.run({
            compactionId: "compact-1",
            attempt: "attempt-1",
            contextRef,
            signal: new AbortController().signal,
            publish: () => undefined,
        })

        // Stopping at the call would leave its answer behind as a result without a call.
        expect(landed).toEqual([
            expect.objectContaining({
                span: { from: { seq: 1 }, to: { seq: 6 } },
                continuation: { text: "answer to turn A" },
            }),
        ])
    })

    it("lands a manual summary only after the user accepts it, regenerating with their feedback first", async () => {
        const payloads = new MemoryPayloads()
        const context: CompactionContextEnvelope = {
            kind: "compaction_context",
            trigger: "manual",
            context: { sourceHistory: [], guidance: "keep failures" },
        }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const requests: unknown[] = []
        const reviewed: string[] = []
        const landed: string[] = []
        const decisions = [
            { action: "regenerate", feedback: "mention the API" } as const,
            { action: "regenerate", feedback: "" } as const,
            { action: "accept" } as const,
        ]
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: {
                run: async ({ context: sent }) => {
                    requests.push(sent)
                    return { summary: `summary ${requests.length}` }
                },
            },
            landing: { land: async (input) => void landed.push(input.summary) },
            review: {
                review: async ({ summary }) => {
                    reviewed.push(summary)
                    // Nothing may land while the user is still deciding.
                    expect(landed).toEqual([])
                    return decisions.shift() ?? { action: "accept" }
                },
            },
        })

        await adapter.run({
            compactionId: "compact-1",
            attempt: "attempt-1",
            contextRef,
            signal: new AbortController().signal,
            publish: () => undefined,
        })

        expect(reviewed).toEqual(["summary 1", "summary 2", "summary 3"])
        // A regeneration is a fresh request: the rejected `/compact` guidance and
        // any earlier feedback are never replayed (WS-013 AC-011), and an empty
        // Regenerate asks for a plain summary.
        expect(requests).toEqual([
            { sourceHistory: [], guidance: "keep failures" },
            { sourceHistory: [], feedback: "mention the API" },
            { sourceHistory: [] },
        ])
        // Only the accepted summary replaces the conversation.
        expect(landed).toEqual(["summary 3"])
    })

    // One compaction is one card: the review is drawn on the row the run's
    // progress occupied, instead of a second copy of the summary beside it.
    it("hands the run's progress card to every review of its summary", async () => {
        const payloads = new MemoryPayloads()
        const context: CompactionContextEnvelope = {
            kind: "compaction_context",
            trigger: "manual",
            context: { sourceHistory: [] },
        }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const handed: string[] = []
        const reviewedRows: Array<number | undefined> = []
        const decisions = [{ action: "regenerate", feedback: "" } as const, { action: "accept" } as const]
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async () => ({ summary: "summary" }) },
            progress: {
                withdraw: () => false,
                handOver: (compactionId) => {
                    handed.push(compactionId)
                    return 17
                },
            },
            review: {
                review: async ({ existingTs }) => {
                    reviewedRows.push(existingTs)
                    return decisions.shift() ?? { action: "accept" }
                },
            },
        })

        await adapter.run({
            compactionId: "compact-1",
            attempt: "attempt-1",
            contextRef,
            signal: new AbortController().signal,
            publish: () => undefined,
        })

        expect(handed).toEqual(["compact-1", "compact-1"])
        expect(reviewedRows).toEqual([17, 17])
    })

    it("never asks for review of an automatic summary", async () => {
        const payloads = new MemoryPayloads()
        const context: CompactionContextEnvelope = { kind: "compaction_context", context: { sourceHistory: [] } }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const landed: string[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async () => ({ summary: "automatic" }) },
            landing: { land: async (input) => void landed.push(input.summary) },
            review: { review: async () => expect.unreachable("automatic compaction must not be reviewed") },
        })

        await adapter.run({
            compactionId: "compact-1",
            attempt: "attempt-1",
            contextRef,
            signal: new AbortController().signal,
            publish: () => undefined,
        })

        expect(landed).toEqual(["automatic"])
    })

    it("lands nothing when the run is stopped during review", async () => {
        const payloads = new MemoryPayloads()
        const context: CompactionContextEnvelope = {
            kind: "compaction_context",
            trigger: "manual",
            context: { sourceHistory: [] },
        }
        const contextRef = await payloads.put(encodeTaskPayload(context))
        const controller = new AbortController()
        const landed: string[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async () => ({ summary: "pending" }) },
            landing: { land: async (input) => void landed.push(input.summary) },
            review: {
                review: async () => {
                    controller.abort("compaction_cancelled")
                    return { action: "accept" }
                },
            },
        })

        await expect(
            adapter.run({
                compactionId: "compact-1",
                attempt: "attempt-1",
                contextRef,
                signal: controller.signal,
                publish: () => undefined,
            }),
        ).rejects.toBe("compaction_cancelled")
        expect(landed).toEqual([])
    })

    it("shows a failed run so the unchanged conversation is not mistaken for a condensed one", async () => {
        const payloads = new MemoryPayloads()
        const contextRef = await payloads.put(
            encodeTaskPayload<CompactionContextEnvelope>({
                kind: "compaction_context",
                trigger: "manual",
                context: { sourceHistory: [] },
            }),
        )
        const presented: string[] = []
        const landed: string[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: {
                run: async () => {
                    throw new Error("Compaction response did not contain summarize_task context")
                },
            },
            landing: { land: async (input) => void landed.push(input.summary) },
            failure: { present: async (input) => void presented.push(`${input.compactionId}/${input.attempt}`) },
        })

        await expect(
            adapter.run({
                compactionId: "compact-1",
                attempt: "attempt-1",
                contextRef,
                signal: new AbortController().signal,
                publish: () => undefined,
            }),
        ).rejects.toThrow("summarize_task context")
        expect(presented).toEqual(["compact-1/attempt-1"])
        expect(landed).toEqual([])
    })

    it("presents no failure for a run the user stopped", async () => {
        const payloads = new MemoryPayloads()
        const contextRef = await payloads.put(
            encodeTaskPayload<CompactionContextEnvelope>({
                kind: "compaction_context",
                trigger: "manual",
                context: { sourceHistory: [] },
            }),
        )
        const controller = new AbortController()
        const presented: string[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: {
                run: async () => {
                    controller.abort("compaction_cancelled")
                    throw new Error("aborted mid-stream")
                },
            },
            failure: { present: async (input) => void presented.push(input.compactionId) },
        })

        await expect(
            adapter.run({
                compactionId: "compact-1",
                attempt: "attempt-1",
                contextRef,
                signal: controller.signal,
                publish: () => undefined,
            }),
        ).rejects.toThrow("aborted mid-stream")
        expect(presented).toEqual([])
    })

    it("presents no failure when a stop withdrew the review before the run's own signal fired", async () => {
        const payloads = new MemoryPayloads()
        const contextRef = await payloads.put(
            encodeTaskPayload<CompactionContextEnvelope>({
                kind: "compaction_context",
                trigger: "manual",
                context: { sourceHistory: [] },
            }),
        )
        const presented: string[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async () => ({ summary: "pending" }) },
            review: {
                review: async () => {
                    throw new CompactionReviewWithdrawnError("dialog_cancel")
                },
            },
            failure: { present: async (input) => void presented.push(input.compactionId) },
        })

        await expect(
            adapter.run({
                compactionId: "compact-1",
                attempt: "attempt-1",
                contextRef,
                signal: new AbortController().signal,
                publish: () => undefined,
            }),
        ).rejects.toBeInstanceOf(CompactionReviewWithdrawnError)
        expect(presented).toEqual([])
    })

    it("withdraws the progress of a run that ended without a record and redraws the view", async () => {
        const payloads = new MemoryPayloads()
        const contextRef = await payloads.put(
            encodeTaskPayload<CompactionContextEnvelope>({
                kind: "compaction_context",
                trigger: "manual",
                context: { sourceHistory: [] },
            }),
        )
        const withdrawn: string[] = []
        const published: unknown[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async () => ({ summary: "pending" }) },
            review: {
                review: async () => {
                    throw new CompactionReviewWithdrawnError("dialog_cancel")
                },
            },
            progress: {
                withdraw: (compactionId) => {
                    withdrawn.push(compactionId)
                    return true
                },
                handOver: () => undefined,
            },
        })

        await expect(
            adapter.run({
                compactionId: "compact-1",
                attempt: "attempt-1",
                contextRef,
                signal: new AbortController().signal,
                publish: (projection) => void published.push(projection),
            }),
        ).rejects.toBeInstanceOf(CompactionReviewWithdrawnError)
        expect(withdrawn).toEqual(["compact-1"])
        expect(published).toEqual([{ kind: "compaction_progress", compactionId: "compact-1", attempt: "attempt-1" }])
    })

    it("withdraws only after the landing recorded the run, so the record can take over its card", async () => {
        const payloads = new MemoryPayloads()
        const contextRef = await payloads.put(
            encodeTaskPayload<CompactionContextEnvelope>({
                kind: "compaction_context",
                context: { sourceHistory: [] },
            }),
        )
        const order: string[] = []
        const published: unknown[] = []
        const adapter = new ProductionCompactionAdapter({
            payloads,
            service: { run: async () => ({ summary: "landed" }) },
            landing: { land: async () => void order.push("land") },
            progress: {
                withdraw: () => {
                    order.push("withdraw")
                    // The landing took the card over, so nothing was left.
                    return false
                },
                handOver: () => undefined,
            },
        })

        await adapter.run({
            compactionId: "compact-1",
            attempt: "attempt-1",
            contextRef,
            signal: new AbortController().signal,
            publish: (projection) => void published.push(projection),
        })
        expect(order).toEqual(["land", "withdraw"])
        expect(published).toEqual([])
    })
})
