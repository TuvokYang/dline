import { describe, it, vi } from "vitest"
// sinon import removed: using vitest globals
import "should"
import { retryWithBackoff } from "./retry"

describe("retryWithBackoff", () => {
    it("returns immediately when operation succeeds on first attempt", async () => {
        const operation = vi.fn().mockResolvedValue("ok")
        const onRetry = vi.fn()

        const result = await retryWithBackoff<string>(operation, {
            operationName: "Immediate success",
            maxAttempts: 3,
            baseDelayMs: 10,
            onRetry,
        })

        result.should.equal("ok")
        operation.mock.calls.length.should.equal(1)
        onRetry.mock.calls.length.should.equal(0)
    })

    it("retries with exponential backoff until success", async () => {
        const _clock = vi.useFakeTimers()
        try {
            let attempt = 0
            const onRetry = vi.fn()

            const resultPromise = retryWithBackoff<string>(
                async () => {
                    attempt++
                    if (attempt < 3) {
                        throw new Error(`fail ${attempt}`)
                    }
                    return "ok"
                },
                {
                    operationName: "Backoff retry",
                    maxAttempts: 4,
                    baseDelayMs: 100,
                    onRetry,
                },
            )

            await Promise.resolve()
            attempt.should.equal(1)

            await vi.advanceTimersByTimeAsync(100)
            attempt.should.equal(2)

            await vi.advanceTimersByTimeAsync(200)
            const result = await resultPromise
            result.should.equal("ok")

            attempt.should.equal(3)
            onRetry.mock.calls.length.should.equal(2)
            onRetry.mock.calls[0][1].should.equal(1)
            onRetry.mock.calls[0][3].should.equal(100)
            onRetry.mock.calls[1][1].should.equal(2)
            onRetry.mock.calls[1][3].should.equal(200)
        } finally {
            vi.useRealTimers()
        }
    })

    it("stops retrying when shouldRetry returns false", async () => {
        const operation = vi.fn().mockRejectedValue(new Error("stop"))
        const shouldRetry = vi.fn().mockReturnValue(false)

        let errorMessage = ""
        try {
            await retryWithBackoff(operation, {
                operationName: "Should retry gate",
                maxAttempts: 5,
                baseDelayMs: 10,
                shouldRetry,
            })
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error)
        }

        operation.mock.calls.length.should.equal(1)
        shouldRetry.mock.calls.length.should.equal(1)
        errorMessage.should.containEql("Should retry gate failed after 1 attempt")
        errorMessage.should.containEql("stop")
    })

    it("throws after max attempts with operation name and last error", async () => {
        let attempt = 0

        let errorMessage = ""
        try {
            await retryWithBackoff(
                async () => {
                    attempt++
                    throw new Error(`fail ${attempt}`)
                },
                {
                    operationName: "Always fails",
                    maxAttempts: 3,
                    baseDelayMs: 1,
                },
            )
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error)
        }

        attempt.should.equal(3)
        errorMessage.should.containEql("Always fails failed after 3 attempts")
        errorMessage.should.containEql("fail 3")
    })
})
