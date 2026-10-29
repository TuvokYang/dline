import type OpenAI from "openai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OpenAIResponsesStreamMonitor, StreamIdleTimeoutError } from "../openai-responses-stream-monitor"

type ResponseEvent = OpenAI.Responses.ResponseStreamEvent

function createControlledStream() {
    const values: IteratorResult<ResponseEvent>[] = []
    const waiters: Array<(value: IteratorResult<ResponseEvent>) => void> = []

    const push = (event: ResponseEvent) => {
        const value = { value: event, done: false } as IteratorResult<ResponseEvent>
        const waiter = waiters.shift()
        if (waiter) waiter(value)
        else values.push(value)
    }

    const complete = () => {
        const value = { value: undefined, done: true } as IteratorResult<ResponseEvent>
        const waiter = waiters.shift()
        if (waiter) waiter(value)
        else values.push(value)
    }

    return {
        push,
        complete,
        stream: {
            [Symbol.asyncIterator]() {
                return {
                    next: () => {
                        const value = values.shift()
                        if (value) return Promise.resolve(value)
                        return new Promise<IteratorResult<ResponseEvent>>((resolve) => waiters.push(resolve))
                    },
                }
            },
        } as AsyncIterable<ResponseEvent>,
    }
}

afterEach(() => {
    vi.useRealTimers()
})

describe("OpenAIResponsesStreamMonitor", () => {
    it("aborts and throws a typed error after the configured event idle timeout", async () => {
        vi.useFakeTimers()
        const controlled = createControlledStream()
        const abort = vi.fn()
        const monitor = new OpenAIResponsesStreamMonitor({
            idleTimeoutMs: 120_000,
            abort,
            log: vi.fn(),
            requestLabel: "Task task-001",
        })
        const iterator = monitor.observe(controlled.stream)[Symbol.asyncIterator]()

        const pending = iterator.next()
        const rejection = expect(pending).rejects.toBeInstanceOf(StreamIdleTimeoutError)
        await vi.advanceTimersByTimeAsync(120_000)

        await rejection
        expect(abort).toHaveBeenCalledOnce()
    })

    it("resets the idle timeout for every raw lifecycle event", async () => {
        vi.useFakeTimers()
        const controlled = createControlledStream()
        const abort = vi.fn()
        const monitor = new OpenAIResponsesStreamMonitor({
            idleTimeoutMs: 120_000,
            abort,
            log: vi.fn(),
            requestLabel: "Task task-001",
        })
        const iterator = monitor.observe(controlled.stream)[Symbol.asyncIterator]()

        const first = iterator.next()
        await vi.advanceTimersByTimeAsync(119_000)
        controlled.push({ type: "response.in_progress" } as ResponseEvent)
        await expect(first).resolves.toMatchObject({ done: false, value: { type: "response.in_progress" } })

        const second = iterator.next()
        await vi.advanceTimersByTimeAsync(119_000)
        controlled.push({ type: "response.created" } as ResponseEvent)
        await expect(second).resolves.toMatchObject({ done: false, value: { type: "response.created" } })

        controlled.complete()
        await expect(iterator.next()).resolves.toMatchObject({ done: true })
        expect(abort).not.toHaveBeenCalled()
    })

    it("reports estimated tokens without logging every sampling interval", async () => {
        vi.useFakeTimers()
        const controlled = createControlledStream()
        const log = vi.fn()
        const onEstimatedTokens = vi.fn()
        const monitor = new OpenAIResponsesStreamMonitor({
            idleTimeoutMs: 120_000,
            abort: vi.fn(),
            log,
            requestLabel: "Task task-001",
            onEstimatedTokens,
        })
        const iterator = monitor.observe(controlled.stream)[Symbol.asyncIterator]()

        const first = iterator.next()
        controlled.push({ type: "response.reasoning_summary_text.delta", delta: "private streamed content" } as ResponseEvent)
        await first
        const second = iterator.next()
        controlled.push({ type: "response.output_text.delta", delta: "hello" } as ResponseEvent)
        await second

        await vi.advanceTimersByTimeAsync(1_000)

        expect(onEstimatedTokens).toHaveBeenCalledWith(8)
        expect(log).not.toHaveBeenCalled()

        controlled.complete()
        await iterator.next()
    })

    it("logs exact completed usage and duration summary", async () => {
        vi.useFakeTimers()
        const log = vi.fn()
        const monitor = new OpenAIResponsesStreamMonitor({
            idleTimeoutMs: 120_000,
            abort: vi.fn(),
            log,
            requestLabel: "Task task-001",
        })
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield {
                    type: "response.completed",
                    response: {
                        usage: {
                            input_tokens: 100,
                            input_tokens_details: { cached_tokens: 60 },
                            output_tokens: 40,
                            output_tokens_details: { reasoning_tokens: 25 },
                        },
                    },
                } as ResponseEvent
            },
        }

        const iterator = monitor.observe(stream)[Symbol.asyncIterator]()
        await iterator.next()
        await iterator.next()

        const logOutput = log.mock.calls.flat().join("\n")
        expect(logOutput).toContain("completed")
        expect(logOutput).toContain("inputTokens=100")
        expect(logOutput).toContain("outputTokens=40")
        expect(logOutput).toContain("cachedInputTokens=60")
        expect(logOutput).toContain("reasoningTokens=25")
        expect(logOutput).toContain("durationMs=")
    })
})
