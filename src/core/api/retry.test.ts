// @ts-nocheck — should library type issues
import { afterEach, describe, it, vi } from "vitest"
import "should"
import { withRetry } from "./retry"
// sinon import removed: using vitest globals
import { OutputLimitExceededError } from "./stream/OutputLimitExceededError"

describe("Retry Decorator", () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    describe("withRetry", () => {
        it("should not retry on success", async () => {
            let callCount = 0
            class TestClass {
                @withRetry()
                async *successMethod() {
                    callCount++
                    yield "success"
                }
            }

            const test = new TestClass()
            const result = []
            for await (const value of test.successMethod()) {
                result.push(value)
            }

            callCount.should.equal(1)
            result.should.deepEqual(["success"])
        })

        it("should retry on rate limit (429) error", async () => {
            let callCount = 0
            class TestClass {
                @withRetry({ maxRetries: 2, baseDelay: 10, maxDelay: 100 })
                async *failMethod() {
                    callCount++
                    if (callCount === 1) {
                        const error: any = new Error("Rate limit exceeded")
                        error.status = 429
                        throw error
                    }
                    yield "success after retry"
                }
            }

            const test = new TestClass()
            const result = []
            for await (const value of test.failMethod()) {
                result.push(value)
            }

            ;(callCount as any).should.equal(2)
            result.should.deepEqual(["success after retry"])
        })

        it("reports retry attempts through ApiHandlerContext", async () => {
            let callCount = 0
            const onRetryAttempt = vi.fn()
            class TestClass {
                ctx = { onRetryAttempt }

                @withRetry({ maxRetries: 2, baseDelay: 1 })
                async *failMethod() {
                    callCount++
                    if (callCount === 1) {
                        const error: any = new Error("Rate limit exceeded")
                        error.status = 429
                        throw error
                    }
                    yield "success"
                }
            }

            for await (const _ of new TestClass().failMethod()) {
                // consume generator
            }

            onRetryAttempt.mock.calls.length.should.equal(1)
            onRetryAttempt.mock.calls[0][0].should.equal(1)
            onRetryAttempt.mock.calls[0][1].should.equal(2)
        })

        it("should not retry on non-rate-limit errors", async () => {
            let callCount = 0
            class TestClass {
                @withRetry()
                async *failMethod() {
                    callCount++
                    throw new Error("Regular error")
                }
            }

            const test = new TestClass()
            try {
                for await (const _ of test.failMethod()) {
                    // Should not reach here
                }
                throw new Error("Should have thrown")
            } catch (error: any) {
                error.message.should.equal("Regular error")
                callCount.should.equal(1)
            }
        })

        it("delegates every compaction request error to the Task retry owner", async () => {
            let callCount = 0
            class TestClass {
                @withRetry({ maxRetries: 3, baseDelay: 1, retryAllErrors: true })
                async *failMethod(_system: string, _messages: unknown[], _tools: unknown, _options: unknown) {
                    callCount++
                    const error = new Error("Rate limit exceeded") as Error & { status: number }
                    error.status = 429
                    throw error
                }
            }

            let caught: unknown
            try {
                for await (const _ of new TestClass().failMethod("system", [], undefined, {
                    generation: { purpose: "compaction", maxOutputTokens: 30_000 },
                })) {
                    // Compaction retry must be orchestrated after Task-owned cleanup.
                }
            } catch (error) {
                caught = error
            }

            ;(caught instanceof Error).should.equal(true)
            callCount.should.equal(1)
        })

        it.each([
            "task",
            "subagent",
            "compaction",
        ] as const)("delegates errors to the explicit %s retry owner", async (retryOwner) => {
            let callCount = 0
            class TestClass {
                @withRetry({ maxRetries: 3, baseDelay: 1, retryAllErrors: true })
                async *failMethod(_system: string, _messages: unknown[], _tools: unknown, _options: unknown) {
                    callCount++
                    const error = new Error("Rate limit exceeded") as Error & { status: number }
                    error.status = 429
                    throw error
                }
            }

            let caught: unknown
            try {
                for await (const _ of new TestClass().failMethod("system", [], undefined, { retryOwner })) {
                    // The declared upper layer owns replay and cleanup.
                }
            } catch (error) {
                caught = error
            }

            ;(caught instanceof Error).should.equal(true)
            callCount.should.equal(1)
        })

        it("propagates Task-owned retry through nested decorated provider adapters", async () => {
            let innerCallCount = 0
            class TestClass {
                @withRetry({ maxRetries: 3, baseDelay: 1, retryAllErrors: true })
                async *innerMethod() {
                    innerCallCount++
                    const error = new Error("Nested rate limit exceeded") as Error & { status: number }
                    error.status = 429
                    throw error
                }

                @withRetry({ maxRetries: 3, baseDelay: 1, retryAllErrors: true })
                async *outerMethod(_system: string, _messages: unknown[], _tools: unknown, _options: unknown) {
                    yield* this.innerMethod()
                }
            }

            let caught: unknown
            try {
                for await (const _ of new TestClass().outerMethod("system", [], undefined, {
                    generation: { purpose: "compaction", maxOutputTokens: 30_000 },
                })) {
                    // Nested providers must delegate retry to the Task boundary.
                }
            } catch (error) {
                caught = error
            }

            ;(caught instanceof Error).should.equal(true)
            innerCallCount.should.equal(1)
        })

        it("forwards consumer cancellation to the provider iterator", async () => {
            let released = false
            class TestClass {
                @withRetry()
                async *streamMethod(_system: string, _messages: unknown[], _tools: unknown, _options: unknown) {
                    try {
                        yield "first"
                        yield "second"
                    } finally {
                        released = true
                    }
                }
            }

            for await (const _ of new TestClass().streamMethod("system", [], undefined, {
                generation: { purpose: "compaction", maxOutputTokens: 30_000 },
            })) {
                break
            }

            released.should.equal(true)
        })

        it("does not retry a typed output-limit error when retryAllErrors is enabled", async () => {
            let callCount = 0
            const outputLimitError = new OutputLimitExceededError("openai_chat", "length")
            class TestClass {
                @withRetry({ maxRetries: 3, baseDelay: 1, retryAllErrors: true })
                async *failMethod() {
                    callCount++
                    throw outputLimitError
                }
            }

            let caught: unknown
            try {
                for await (const _ of new TestClass().failMethod()) {
                    // Output-limit termination must escape before a generic retry is scheduled.
                }
            } catch (error) {
                caught = error
            }

            ;(caught === outputLimitError).should.equal(true)
            callCount.should.equal(1)
        })

        it("should respect retry-after header with delta seconds", async () => {
            let callCount = 0
            const setTimeoutSpy = vi.spyOn(global, "setTimeout")
            const baseDelay = 1000

            class TestClass {
                @withRetry({ maxRetries: 2, baseDelay }) // Use large baseDelay to ensure header takes precedence
                async *failMethod() {
                    callCount++
                    if (callCount === 1) {
                        const error: any = new Error("Rate limit exceeded")
                        error.status = 429
                        error.headers = { "retry-after": "0.01" } // 10ms delay
                        throw error
                    }
                    yield "success after retry"
                }
            }

            const test = new TestClass()
            const result = []
            for await (const value of test.failMethod()) {
                result.push(value)
            }

            ;(callCount as any).should.equal(2)
            setTimeoutSpy.mock.calls.length.should.equal(1)
            const [_, delay] = setTimeoutSpy.mock.calls[0]
            delay?.should.equal(0)

            result.should.deepEqual(["success after retry"])
        })

        it("should respect retry-after header with Unix timestamp", async () => {
            const fixedDate = new Date("2010-01-01T00:00:00.000Z")
            vi.spyOn(Date, "now").mockReturnValue(fixedDate.getTime())
            const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: any[]) => void) => {
                queueMicrotask(callback)
                return {} as NodeJS.Timeout
            }) as typeof setTimeout)
            let callCount = 0
            const retryTimestamp = Math.floor(fixedDate.getTime() / 1000) + 1
            const baseDelay = 1000

            class TestClass {
                @withRetry({ maxRetries: 2, baseDelay }) // Use large baseDelay to ensure header takes precedence
                async *failMethod() {
                    callCount++
                    if (callCount === 1) {
                        const error: any = new Error("Rate limit exceeded")
                        error.status = 429
                        error.headers = { "retry-after": retryTimestamp.toString() }
                        throw error
                    }
                    yield "success after retry"
                }
            }

            const result = []
            for await (const value of new TestClass().failMethod()) result.push(value)

            ;(callCount as any).should.equal(2)
            setTimeoutSpy.mock.calls.length.should.equal(1)
            const [_, delay] = setTimeoutSpy.mock.calls[0]
            delay?.should.equal(1_000)

            result.should.deepEqual(["success after retry"])
        })

        it("should use exponential backoff when no retry-after header", async () => {
            const setTimeoutSpy = vi.spyOn(global, "setTimeout")
            let callCount = 0
            const baseDelay = 10

            class TestClass {
                @withRetry({ maxRetries: 2, baseDelay, maxDelay: 100 })
                async *failMethod() {
                    callCount++
                    if (callCount === 1) {
                        const error: any = new Error("Rate limit exceeded")
                        error.status = 429
                        throw error
                    }
                    yield "success after retry"
                }
            }

            const test = new TestClass()
            const result = []
            for await (const value of test.failMethod()) {
                result.push(value)
            }

            ;(callCount as any).should.equal(2)
            setTimeoutSpy.mock.calls.length.should.equal(1)
            const [_, delay] = setTimeoutSpy.mock.calls[0]
            delay?.should.equal(baseDelay)

            result.should.deepEqual(["success after retry"])
        })

        it("should respect maxDelay", async () => {
            const setTimeoutSpy = vi.spyOn(global, "setTimeout")
            let callCount = 0
            const baseDelay = 50
            const maxDelay = 10

            class TestClass {
                @withRetry({ maxRetries: 3, baseDelay, maxDelay })
                async *failMethod() {
                    callCount++
                    if (callCount < 3) {
                        const error: any = new Error("Rate limit exceeded")
                        error.status = 429
                        throw error
                    }
                    yield "success after retries"
                }
            }

            const test = new TestClass()
            const result = []
            for await (const value of test.failMethod()) {
                result.push(value)
            }

            ;(callCount as any).should.equal(3)
            setTimeoutSpy.mock.calls.length.should.equal(2)
            setTimeoutSpy.mock.calls.map(([, delay]) => delay).should.deepEqual([maxDelay, maxDelay])

            result.should.deepEqual(["success after retries"])
        })

        it("should throw after maxRetries attempts", async () => {
            let callCount = 0
            class TestClass {
                @withRetry({ maxRetries: 2, baseDelay: 10 })
                async *failMethod() {
                    callCount++
                    const error: any = new Error("Rate limit exceeded")
                    error.status = 429
                    throw error
                }
            }

            const test = new TestClass()
            try {
                for await (const _ of test.failMethod()) {
                    // Should not reach here
                }
                throw new Error("Should have thrown")
            } catch (error: any) {
                error.message.should.equal("Rate limit exceeded")
                ;(callCount as any).should.equal(2) // Initial attempt + 1 retry
            }
        })
    })
})
