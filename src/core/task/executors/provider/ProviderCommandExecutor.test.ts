import { describe, expect, it, vi } from "vitest"
import type { ProviderStartCommand, TaskEvent } from "../../kernel"
import { InMemoryConversationJournal, InMemoryTaskViewPort } from "../../stores"
import { ProviderCommandExecutor, type ProviderExecutionChunk } from "./ProviderCommandExecutor"

const command: ProviderStartCommand = {
    commandId: "provider:1",
    originRevision: 2,
    generation: 0,
    type: "provider.start",
    draftRef: "draft:1",
    turnId: "turn-request",
}

function recorder() {
    const events: TaskEvent[] = []
    return {
        events,
        sink: {
            submit: vi.fn(async (event: TaskEvent) => {
                events.push(event)
                return { kind: "accepted" as const }
            }),
        },
    }
}

async function* chunks(values: readonly ProviderExecutionChunk[]): AsyncIterable<ProviderExecutionChunk> {
    for (const value of values) yield value
}

describe("ProviderCommandExecutor", () => {
    it("projects partial data transiently and finalizes one durable journal entry", async () => {
        const recorded = recorder()
        const journal = new InMemoryConversationJournal()
        const taskView = new InMemoryTaskViewPort()
        const usage = vi.fn()
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        {
                            kind: "partial",
                            transientId: "stream-1",
                            projection: { text: "partial" },
                        },
                        {
                            kind: "final",
                            transientId: "stream-1",
                            turnId: "turn-request",
                            payloadRef: "payload:final",
                            turnPlan: { mode: "serial", blocks: [] },
                        },
                        { kind: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
                    ]),
                recordUsage: usage,
            },
            journal,
            taskView,
            recorded.sink,
        )
        await executor.execute(command)
        expect(taskView.transient).toEqual([{ taskId: "task-1", projection: { text: "partial" } }])
        expect(await journal.read()).toEqual([
            expect.objectContaining({ kind: "message", payloadRef: "payload:final", transientId: "stream-1" }),
        ])
        expect(usage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 2 })
        expect(recorded.events).toEqual([
            {
                type: "provider.turn_ready",
                generation: 0,
                commandId: "provider:1",
                originRevision: 2,
                turnId: "turn-request",
                finalPayloadRef: "payload:final",
                journalWatermark: { seq: 1 },
                turnPlan: { mode: "serial", blocks: [] },
            },
        ])
    })

    // A reply whose reasoning the provider keeps opaque and that adds no prose or
    // tool call streams nothing the chat can show. It is still a completed turn.
    it("journals a final that no partial preceded instead of finalizing an unopened stream", async () => {
        const recorded = recorder()
        const journal = new InMemoryConversationJournal()
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        {
                            kind: "final",
                            transientId: "stream-1",
                            turnId: "turn-request",
                            payloadRef: "payload:final",
                            turnPlan: { mode: "serial", blocks: [] },
                        },
                    ]),
            },
            journal,
            new InMemoryTaskViewPort(),
            recorded.sink,
        )

        await executor.execute(command)

        expect(await journal.read()).toEqual([
            expect.objectContaining({ kind: "message", operationId: "provider.final:provider:1", payloadRef: "payload:final" }),
        ])
        expect(recorded.events).toEqual([
            expect.objectContaining({
                type: "provider.turn_ready",
                finalPayloadRef: "payload:final",
                journalWatermark: { seq: 1 },
            }),
        ])
    })

    it("finishes presentation and kernel settlement when cancellation lands after the final journal append", async () => {
        const recorded = recorder()
        const journal = new InMemoryConversationJournal()
        const presentation = { showPartial: vi.fn(), commit: vi.fn(async () => undefined) }
        let stop: () => void = () => undefined
        const finalize = journal.finalizeTransient.bind(journal)
        vi.spyOn(journal, "finalizeTransient").mockImplementation(async (input) => {
            const result = await finalize(input)
            stop()
            return result
        })
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        { kind: "partial", transientId: "stream-1", text: "answer" },
                        {
                            kind: "final",
                            transientId: "stream-1",
                            turnId: "turn-request",
                            payloadRef: "payload:final",
                            text: "answer",
                            turnPlan: { mode: "serial", blocks: [] },
                        },
                    ]),
            },
            journal,
            new InMemoryTaskViewPort(),
            recorded.sink,
            presentation,
        )
        stop = () => executor.cancelAll("provider_cancel")

        await executor.execute(command)

        expect(presentation.commit).toHaveBeenCalledWith({ transientId: "stream-1", text: "answer" })
        expect(recorded.events).toEqual([
            expect.objectContaining({ type: "provider.turn_ready", finalPayloadRef: "payload:final" }),
        ])
    })

    it("replays an existing durable final without requesting the provider again", async () => {
        const recorded = recorder()
        const journal = new InMemoryConversationJournal()
        await journal.append({
            operationId: "provider.final:provider:1",
            payloadRef: "payload:existing",
            source: "provider",
            causation: { commandId: "provider:old", originRevision: 1, generation: 0, turnId: "turn-request" },
        })
        const start = vi.fn(() => chunks([]))
        const recoverFinal = vi.fn(async () => ({ turnPlan: { mode: "serial" as const, blocks: [] } }))
        const port = { start, recoverFinal }
        const executor = new ProviderCommandExecutor("task-1", port, journal, new InMemoryTaskViewPort(), recorded.sink)

        await executor.execute(command)

        expect(start).not.toHaveBeenCalled()
        expect(recoverFinal).toHaveBeenCalledWith("payload:existing")
        expect(recorded.events).toEqual([
            expect.objectContaining({
                type: "provider.turn_ready",
                turnId: "turn-request",
                finalPayloadRef: "payload:existing",
                journalWatermark: { seq: 1 },
            }),
        ])
    })

    it("journals what a stopped reply already said and settles its rows, without planning a turn", async () => {
        const recorded = recorder()
        const journal = new InMemoryConversationJournal()
        const presentation = { showPartial: vi.fn(), commit: vi.fn(async () => undefined) }
        let stop: () => void = () => undefined
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: async function* () {
                    yield {
                        kind: "partial",
                        transientId: "stream-1",
                        text: "",
                        reasoning: "THOUGHT",
                    } as ProviderExecutionChunk
                    stop()
                    yield {
                        kind: "interrupted",
                        transientId: "stream-1",
                        payloadRef: "payload:interrupted",
                        text: "",
                        reasoning: "THOUGHT",
                    } as ProviderExecutionChunk
                },
            },
            journal,
            new InMemoryTaskViewPort(),
            recorded.sink,
            presentation,
        )
        stop = () => executor.cancelAll("provider_cancel")

        await executor.execute(command)

        expect(await journal.read()).toEqual([
            expect.objectContaining({
                kind: "message",
                operationId: "provider.interrupted:provider:1",
                payloadRef: "payload:interrupted",
                transientId: "stream-1",
            }),
        ])
        expect(presentation.showPartial).toHaveBeenCalledWith({ transientId: "stream-1", text: "", reasoning: "THOUGHT" })
        expect(presentation.commit).toHaveBeenCalledWith({ transientId: "stream-1", text: "", reasoning: "THOUGHT" })
        // A stopped reply plans no turn: nothing it was calling runs.
        expect(recorded.events).toEqual([])
    })

    it("withdraws the streamed rows of a reply stopped before it produced anything to keep", async () => {
        const recorded = recorder()
        const journal = new InMemoryConversationJournal()
        const discardTransient = vi.spyOn(journal, "discardTransient")
        const presentation = { showPartial: vi.fn(), commit: vi.fn(async () => undefined) }
        let stop: () => void = () => undefined
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: async function* () {
                    yield { kind: "partial", transientId: "stream-1" } as ProviderExecutionChunk
                    stop()
                },
            },
            journal,
            new InMemoryTaskViewPort(),
            recorded.sink,
            presentation,
        )
        stop = () => executor.cancelAll("provider_cancel")

        await executor.execute(command)

        expect(await journal.read()).toEqual([])
        expect(discardTransient).toHaveBeenCalledWith("stream-1")
        expect(presentation.commit).toHaveBeenCalledWith({ transientId: "stream-1", text: "" })
        expect(recorded.events).toEqual([])
    })

    it("withdraws an undurable partial when the provider stream fails", async () => {
        const recorded = recorder()
        const journal = new InMemoryConversationJournal()
        const discardTransient = vi.spyOn(journal, "discardTransient")
        const presentation = { showPartial: vi.fn(), commit: vi.fn(async () => undefined) }
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: async function* () {
                    yield { kind: "partial", transientId: "stream-1", text: "partial" } as ProviderExecutionChunk
                    throw new Error("provider stream failed")
                },
            },
            journal,
            new InMemoryTaskViewPort(),
            recorded.sink,
            presentation,
        )

        await executor.execute(command)

        expect(await journal.read()).toEqual([])
        expect(discardTransient).toHaveBeenCalledWith("stream-1")
        expect(presentation.commit).toHaveBeenCalledWith({ transientId: "stream-1", text: "" })
        expect(recorded.events).toEqual([expect.objectContaining({ type: "provider.failed" })])
    })

    it("reports a storage failure after cancellation instead of swallowing it as an abort", async () => {
        const recorded = recorder()
        const journal = new InMemoryConversationJournal()
        const discardTransient = vi.spyOn(journal, "discardTransient")
        vi.spyOn(journal, "finalizeTransient").mockRejectedValueOnce(new Error("journal unavailable"))
        const presentation = { showPartial: vi.fn(), commit: vi.fn(async () => undefined) }
        let stop: () => void = () => undefined
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: async function* () {
                    yield { kind: "partial", transientId: "stream-1", text: "partial" } as ProviderExecutionChunk
                    stop()
                    yield {
                        kind: "interrupted",
                        transientId: "stream-1",
                        payloadRef: "payload:interrupted",
                        text: "partial",
                    } as ProviderExecutionChunk
                },
            },
            journal,
            new InMemoryTaskViewPort(),
            recorded.sink,
            presentation,
        )
        stop = () => executor.cancelAll("provider_cancel")

        await executor.execute(command)

        expect(discardTransient).toHaveBeenCalledWith("stream-1")
        expect(presentation.commit).toHaveBeenCalledWith({ transientId: "stream-1", text: "" })
        expect(recorded.events).toEqual([expect.objectContaining({ type: "provider.failed" })])
    })

    it("rejects a final chunk for another turn", async () => {
        const recorded = recorder()
        const journal = new InMemoryConversationJournal()
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        {
                            kind: "final",
                            turnId: "turn-other",
                            payloadRef: "payload:final",
                            turnPlan: { mode: "serial", blocks: [] },
                        },
                    ]),
            },
            journal,
            new InMemoryTaskViewPort(),
            recorded.sink,
        )
        await executor.execute(command)
        expect(await journal.read()).toEqual([])
        expect(recorded.events).toEqual([
            expect.objectContaining({
                type: "provider.failed",
                commandId: "provider:1",
                message: "provider execution failed (Error)",
            }),
        ])
    })

    it("rejects content after final without publishing or finalizing the turn", async () => {
        const recorded = recorder()
        const journal = new InMemoryConversationJournal()
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        {
                            kind: "final",
                            turnId: "turn-request",
                            payloadRef: "payload:final",
                            turnPlan: { mode: "serial", blocks: [] },
                        },
                        { kind: "partial", transientId: "late" },
                    ]),
            },
            journal,
            new InMemoryTaskViewPort(),
            recorded.sink,
        )
        await executor.execute(command)
        expect(await journal.read()).toEqual([])
        expect(recorded.events).toEqual([
            {
                type: "provider.failed",
                generation: 0,
                commandId: "provider:1",
                originRevision: 2,
                turnId: "turn-request",
                message: "provider execution failed (Error)",
                presentation: JSON.stringify({ message: "Dline provider execution failed: ChunkAfterFinal", code: "Error" }),
            },
        ])
    })

    it("emits a sanitized provider failure when the stream has no final chunk", async () => {
        const recorded = recorder()
        const executor = new ProviderCommandExecutor(
            "task-1",
            { start: () => chunks([]) },
            new InMemoryConversationJournal(),
            new InMemoryTaskViewPort(),
            recorded.sink,
        )
        await executor.execute(command)
        expect(recorded.events).toEqual([
            {
                type: "provider.failed",
                generation: 0,
                commandId: "provider:1",
                originRevision: 2,
                turnId: "turn-request",
                message: "provider execution failed (Error)",
                // The chat names the failure itself, never only an interaction id.
                presentation: JSON.stringify({ message: "Dline provider execution failed: MissingFinalChunk", code: "Error" }),
            },
        ])
    })

    it("cancels an active stream without reporting a provider failure", async () => {
        const recorded = recorder()
        let started!: () => void
        const ready = new Promise<void>((resolve) => (started = resolve))
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: ({ signal }) => ({
                    async *[Symbol.asyncIterator]() {
                        started()
                        await new Promise<void>((_resolve, reject) =>
                            signal.addEventListener(
                                "abort",
                                () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
                                { once: true },
                            ),
                        )
                    },
                }),
            },
            new InMemoryConversationJournal(),
            new InMemoryTaskViewPort(),
            recorded.sink,
        )
        const execution = executor.execute(command)
        await ready
        expect(executor.cancel(command.commandId)).toBe(true)
        await execution
        expect(recorded.events).toEqual([])
    })
})

describe("ProviderCommandExecutor round checkpoint", () => {
    const finalTurn: ProviderExecutionChunk = {
        kind: "final",
        turnId: "turn-request",
        payloadRef: "payload:final",
        turnPlan: { mode: "serial", blocks: [] },
    }

    it("starts the provider request without waiting for the round restore point", async () => {
        const order: string[] = []
        let releaseCheckpoint!: () => void
        const checkpoint = new Promise<void>((resolve) => {
            releaseCheckpoint = resolve
        })
        const beforeRequest = vi.fn(async (_turnId: string) => {
            order.push("checkpoint")
            await checkpoint
            order.push("checkpoint_done")
        })
        const afterProviderStarted = vi.fn(() => order.push("watcher"))
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () => {
                    order.push("request")
                    return chunks([finalTurn])
                },
            },
            new InMemoryConversationJournal(),
            new InMemoryTaskViewPort(),
            recorder().sink,
            undefined,
            {
                begin: vi.fn(async () => {
                    order.push("request_row")
                    return { settle: vi.fn(async () => {}) }
                }),
            },
            { beforeRequest },
            { afterProviderStarted },
        )

        const execution = executor.execute(command)
        await vi.waitFor(() => expect(order).toContain("request"))

        expect(order.slice(0, 3)).toEqual(["checkpoint", "request_row", "request"])
        expect(beforeRequest).toHaveBeenCalledWith("turn-request", expect.any(AbortSignal))
        releaseCheckpoint()
        await execution
        expect(afterProviderStarted).toHaveBeenCalledOnce()
        expect(order.indexOf("watcher")).toBeGreaterThan(order.indexOf("request"))
        await vi.waitFor(() => expect(order).toContain("checkpoint_done"))
    })

    it("still sends the request when the restore point cannot be written", async () => {
        const recorded = recorder()
        const executor = new ProviderCommandExecutor(
            "task-1",
            { start: () => chunks([finalTurn]) },
            new InMemoryConversationJournal(),
            new InMemoryTaskViewPort(),
            recorded.sink,
            undefined,
            undefined,
            {
                beforeRequest: vi.fn(async () => {
                    throw new Error("shadow git unavailable")
                }),
            },
        )

        await executor.execute(command)

        expect(recorded.events).toEqual([expect.objectContaining({ type: "provider.turn_ready" })])
    })
})

describe("ProviderCommandExecutor request reporting", () => {
    function reporter() {
        const settle = vi.fn(async () => {})
        const begin = vi.fn(async () => ({ settle }))
        return { begin, settle, port: { begin } }
    }

    it("settles a completed request with the usage the turn reported", async () => {
        const report = reporter()
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        { kind: "usage", usage: { inputTokens: 10, cacheReadTokens: 4, totalCost: 0.5 } },
                        {
                            kind: "final",
                            turnId: "turn-request",
                            payloadRef: "payload:final",
                            turnPlan: { mode: "serial", blocks: [] },
                        },
                        { kind: "usage", usage: { outputTokens: 7, totalCost: 0.9 } },
                    ]),
            },
            new InMemoryConversationJournal(),
            new InMemoryTaskViewPort(),
            recorder().sink,
            undefined,
            report.port,
        )

        await executor.execute(command)

        expect(report.begin).toHaveBeenCalledWith({ turnId: "turn-request" })
        // Token counts accumulate across chunks; a reported total cost replaces
        // the previous total instead of being summed into a double charge.
        expect(report.settle).toHaveBeenCalledWith({
            usage: { inputTokens: 10, cacheReadTokens: 4, totalCost: 0.9, outputTokens: 7 },
            contextUsage: { inputTokens: 10, cacheReadTokens: 4, totalCost: 0.9, outputTokens: 7 },
            outcome: "completed",
        })
    })

    it("keeps an abandoned attempt's usage out of the context the retried request occupies", async () => {
        const report = reporter()
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        // The first send reported its prompt before the stream broke.
                        {
                            kind: "usage",
                            usage: { inputTokens: 4, cacheReadTokens: 367_654, cacheWriteTokens: 4_480, totalCost: 0.2 },
                        },
                        { kind: "usage", usage: { outputTokens: 8 } },
                        { kind: "retry", notice: { attempt: 1, maxAttempts: 5, delayMs: 0, errorMessage: "{}" } },
                        { kind: "usage", usage: { inputTokens: 4, cacheReadTokens: 372_134, totalCost: 0.3 } },
                        {
                            kind: "final",
                            turnId: "turn-request",
                            payloadRef: "payload:final",
                            turnPlan: { mode: "serial", blocks: [] },
                        },
                        { kind: "usage", usage: { outputTokens: 274 } },
                    ]),
            },
            new InMemoryConversationJournal(),
            new InMemoryTaskViewPort(),
            recorder().sink,
            undefined,
            report.port,
        )

        await executor.execute(command)

        expect(report.settle).toHaveBeenCalledWith({
            // Every attempt consumed tokens and cost, so consumption sums them.
            usage: {
                inputTokens: 8,
                cacheReadTokens: 739_788,
                cacheWriteTokens: 4_480,
                totalCost: 0.5,
                outputTokens: 282,
            },
            // Only the attempt that produced the turn describes what the next request carries.
            contextUsage: { inputTokens: 4, cacheReadTokens: 372_134, totalCost: 0.3, outputTokens: 274 },
            outcome: "completed",
        })
    })

    it("settles a failed request so its row cannot stay running", async () => {
        const report = reporter()
        const executor = new ProviderCommandExecutor(
            "task-1",
            { start: () => chunks([]) },
            new InMemoryConversationJournal(),
            new InMemoryTaskViewPort(),
            recorder().sink,
            undefined,
            report.port,
        )

        await executor.execute(command)

        expect(report.settle).toHaveBeenCalledWith({ usage: undefined, outcome: "failed" })
    })

    it("settles a cancelled request as cancelled rather than failed", async () => {
        let started!: () => void
        const ready = new Promise<void>((resolve) => (started = resolve))
        const report = reporter()
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: ({ signal }) => ({
                    async *[Symbol.asyncIterator]() {
                        started()
                        await new Promise<void>((_resolve, reject) =>
                            signal.addEventListener(
                                "abort",
                                () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
                                { once: true },
                            ),
                        )
                    },
                }),
            },
            new InMemoryConversationJournal(),
            new InMemoryTaskViewPort(),
            recorder().sink,
            undefined,
            report.port,
        )

        const execution = executor.execute(command)
        await ready
        executor.cancel(command.commandId)
        await execution

        expect(report.settle).toHaveBeenCalledWith({ usage: undefined, outcome: "cancelled" })
    })

    it("reports retries before the first chunk and their recovery, without journaling anything", async () => {
        const retrying = vi.fn(async () => {})
        const recovered = vi.fn(async () => {})
        const settle = vi.fn(async () => {})
        const journal = new InMemoryConversationJournal()
        const notice = { attempt: 1, maxAttempts: 5, delayMs: 3000, errorMessage: "{}" }
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        { kind: "retry", notice },
                        { kind: "partial", transientId: "stream-1" },
                        {
                            kind: "final",
                            transientId: "stream-1",
                            turnId: "turn-request",
                            payloadRef: "payload:final",
                            turnPlan: { mode: "serial", blocks: [] },
                        },
                    ]),
            },
            journal,
            new InMemoryTaskViewPort(),
            recorder().sink,
            undefined,
            { begin: async () => ({ retrying, recovered, settle }) },
        )

        await executor.execute(command)

        expect(retrying).toHaveBeenCalledWith(notice)
        expect(recovered).toHaveBeenCalledOnce()
        expect(settle).toHaveBeenCalledWith({ usage: undefined, outcome: "completed" })
        expect(await journal.read()).toEqual([expect.objectContaining({ payloadRef: "payload:final" })])
    })

    it("forwards streaming occupancy without ending a retry, journaling it, or mistaking it for the reply", async () => {
        const receiving = vi.fn(async () => {})
        const recovered = vi.fn(async () => {})
        const settle = vi.fn(async () => {})
        const journal = new InMemoryConversationJournal()
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        { kind: "retry", notice: { attempt: 1, maxAttempts: 5, delayMs: 0, errorMessage: "{}" } },
                        { kind: "receiving", receivingTokens: 0, authoritativeContextTokens: 6_500 },
                        { kind: "partial", transientId: "stream-1" },
                        { kind: "receiving", receivingTokens: 12, authoritativeContextTokens: 6_500 },
                        {
                            kind: "final",
                            transientId: "stream-1",
                            turnId: "turn-request",
                            payloadRef: "payload:final",
                            turnPlan: { mode: "serial", blocks: [] },
                        },
                        // A late figure after the reply is still only presentation.
                        { kind: "receiving", receivingTokens: 20, authoritativeContextTokens: 6_520 },
                    ]),
            },
            journal,
            new InMemoryTaskViewPort(),
            recorder().sink,
            undefined,
            { begin: async () => ({ retrying: async () => {}, recovered, receiving, settle }) },
        )

        await executor.execute(command)

        expect(receiving.mock.calls).toEqual([
            [{ receivingTokens: 0, authoritativeContextTokens: 6_500 }],
            [{ receivingTokens: 12, authoritativeContextTokens: 6_500 }],
            [{ receivingTokens: 20, authoritativeContextTokens: 6_520 }],
        ])
        // Only the first content chunk ends the retry.
        expect(recovered).toHaveBeenCalledOnce()
        expect(settle).toHaveBeenCalledWith({ usage: undefined, outcome: "completed" })
        expect(await journal.read()).toEqual([expect.objectContaining({ payloadRef: "payload:final" })])
    })

    it("rejects a retry after the stream already produced output", async () => {
        const recorded = recorder()
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        { kind: "partial", transientId: "stream-1" },
                        { kind: "retry", notice: { attempt: 1, maxAttempts: 5, delayMs: 3000, errorMessage: "{}" } },
                    ]),
            },
            new InMemoryConversationJournal(),
            new InMemoryTaskViewPort(),
            recorded.sink,
        )

        await executor.execute(command)

        expect(recorded.events).toEqual([expect.objectContaining({ type: "provider.failed" })])
    })

    it("keeps the turn when reporting throws", async () => {
        const recorded = recorder()
        const executor = new ProviderCommandExecutor(
            "task-1",
            {
                start: () =>
                    chunks([
                        {
                            kind: "final",
                            turnId: "turn-request",
                            payloadRef: "payload:final",
                            turnPlan: { mode: "serial", blocks: [] },
                        },
                    ]),
            },
            new InMemoryConversationJournal(),
            new InMemoryTaskViewPort(),
            recorded.sink,
            undefined,
            {
                begin: async () => ({
                    settle: async () => {
                        throw new Error("reporting unavailable")
                    },
                }),
            },
        )

        await executor.execute(command)

        expect(recorded.events).toEqual([expect.objectContaining({ type: "provider.turn_ready" })])
    })
})
