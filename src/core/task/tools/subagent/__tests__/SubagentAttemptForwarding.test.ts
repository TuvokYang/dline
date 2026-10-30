import { describe, expect, it } from "vitest"
import { type ApiHandler, type ApiHandlerContext } from "@/core/api/ApiHandler"
import { instrumentApiHandler } from "@/core/api/observability/instrument-api-handler"
import type { ApiProviderStreamChunk } from "@/core/api/transform/stream"
import {
    type ProviderAttemptScopeInput,
    registerTaskTraceSource,
    type TaskTraceSource,
} from "@/services/telemetry/service/task-trace-context"
import { forwardProviderAttempt, producesUnreplayableOutput } from "../SubagentAttemptForwarding"

/**
 * The Runner owns the Provider stream by hand, so nothing upstream closes it for
 * it. These tests prove the forwarding unit returns what it buffered, closes the
 * iterator it owns, and — through the real mandatory instrumentation — keeps the
 * usage the Provider already reported.
 */

function chunkStream(chunks: readonly ApiProviderStreamChunk[]): {
    stream: AsyncIterable<ApiProviderStreamChunk>
    closed: () => boolean
} {
    let closed = false
    async function* generate(): AsyncGenerator<ApiProviderStreamChunk> {
        try {
            for (const chunk of chunks) yield chunk
        } finally {
            closed = true
        }
    }
    return { stream: generate(), closed: () => closed }
}

async function collect(stream: AsyncIterable<ApiProviderStreamChunk>): Promise<ApiProviderStreamChunk[]> {
    const seen: ApiProviderStreamChunk[] = []
    for await (const chunk of stream) seen.push(chunk)
    return seen
}

/** Consume only the first chunk, then abandon the generator the way the Runner does. */
async function consumeFirstThenAbandon(stream: AsyncIterable<ApiProviderStreamChunk>): Promise<ApiProviderStreamChunk[]> {
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    // `return()` on the forwarding generator, exactly as an abandoning consumer does.
    await iterator.return?.(undefined)
    return first.done ? [] : [first.value]
}

interface RecordedUsage {
    readonly role: string
    readonly inputTokens: number
    readonly outputTokens: number
}

describe("forwardProviderAttempt", () => {
    it("forwards replayable scaffolding immediately and buffers attempt commits until the end", async () => {
        const { stream } = chunkStream([
            { type: "reasoning", reasoning: "thinking" } satisfies ApiProviderStreamChunk,
            { type: "usage", inputTokens: 10, outputTokens: 2 } satisfies ApiProviderStreamChunk,
            {
                type: "tool_calls",
                function_id: "call-1",
                tool_call: { function: { name: "read_file", arguments: "{}" } },
            } satisfies ApiProviderStreamChunk,
        ])

        const forwarded: ApiProviderStreamChunk[] = []
        const iterator = forwardProviderAttempt(stream[Symbol.asyncIterator]())
        // The first `next()` must surface the reasoning chunk before either commit chunk.
        const first = await iterator.next()
        forwarded.push(first.value as ApiProviderStreamChunk)
        forwarded.push(...(await collect(iterator)))

        expect(forwarded.map((chunk) => chunk.type)).toEqual(["reasoning", "usage", "tool_calls"])
    })

    it("closes the iterator it owns when abandoned before any unreplayable chunk", async () => {
        const { stream, closed } = chunkStream([
            { type: "reasoning", reasoning: "thinking" } satisfies ApiProviderStreamChunk,
            { type: "text", text: "answer" } satisfies ApiProviderStreamChunk,
        ])

        const seen = await consumeFirstThenAbandon(forwardProviderAttempt(stream[Symbol.asyncIterator]()))

        expect(seen.map((chunk) => chunk.type)).toEqual(["reasoning"])
        expect(closed()).toBe(true)
    })

    it("keeps the reported usage of an attempt abandoned after its first chunk", async () => {
        const recorded: RecordedUsage[] = []
        const scope: ProviderAttemptScopeInput = { role: "subagent", logicalRequestId: "request-a", taskAttempt: 0 }
        const trace: TaskTraceSource = {
            currentSpan: () => undefined,
            attributes: () => ({}),
            event: () => undefined,
            failure: () => undefined,
            providerAttemptObserver: () => ({
                beginAttempt: () => undefined,
                finishAttempt: () => undefined,
            }),
            providerAttemptUsage: (input) => {
                recorded.push({
                    role: input.role,
                    inputTokens: input.usage.inputTokens,
                    outputTokens: input.usage.outputTokens,
                })
            },
            providerRequestCompleted: () => undefined,
        }
        const handler = {
            getProviderId: () => "openai",
            createMessage: () =>
                chunkStream([
                    { type: "usage", inputTokens: 120, outputTokens: 30 } satisfies ApiProviderStreamChunk,
                    { type: "text", text: "answer" } satisfies ApiProviderStreamChunk,
                ]).stream,
        } as unknown as ApiHandler
        // The mandatory wrapper resolves the trace through the Task registry, not the
        // handler context, so the test registers the same way a live Task does.
        const unregister = registerTaskTraceSource("task-a", trace)
        const context = { ulid: "task-a", profile: { provider: "openai" } } as unknown as ApiHandlerContext
        const instrumented = instrumentApiHandler(handler, context)

        const options = {
            telemetryRole: scope.role,
            telemetryRequestId: scope.logicalRequestId,
            telemetryAttempt: scope.taskAttempt,
        }
        const seen = await consumeFirstThenAbandon(
            forwardProviderAttempt(instrumented.createMessage("", [], undefined, options)[Symbol.asyncIterator]()),
        )
        unregister()

        // The first chunk is the buffered usage; the text never had to be read.
        expect(seen.map((chunk) => chunk.type)).toEqual(["usage"])
        expect(recorded).toEqual([{ role: "subagent", inputTokens: 120, outputTokens: 30 }])
    })
})

describe("producesUnreplayableOutput", () => {
    it("treats only committed content as unreplayable", () => {
        expect(producesUnreplayableOutput({ type: "reasoning" })).toBe(false)
        expect(producesUnreplayableOutput({ type: "usage" })).toBe(false)
        expect(producesUnreplayableOutput({ type: "tool_calls" })).toBe(false)
        expect(producesUnreplayableOutput({ type: "text", text: "   " })).toBe(false)
        expect(producesUnreplayableOutput({ type: "text", text: "\n\t " })).toBe(false)
        expect(producesUnreplayableOutput({ type: "text", text: "answer" })).toBe(true)
        expect(producesUnreplayableOutput({ type: "server_tool" })).toBe(true)
    })
})
