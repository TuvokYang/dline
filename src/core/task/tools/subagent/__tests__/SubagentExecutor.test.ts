import { strict as assert } from "node:assert"
import { afterEach, describe, it, vi } from "vitest"
import { runSubagent, type SubagentExecResult, type SubagentRunnerLike } from "../SubagentExecutor"

const COMPLETED_RESULT: SubagentExecResult = {
    status: "completed",
    result: "bounded findings",
    stats: {
        toolCalls: 3,
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalCost: 0,
        currency: "USD",
        contextTokens: 15,
        contextWindow: 1000,
        contextUsagePercentage: 1.5,
    },
}

describe("SubagentExecutor", () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it("requests a timeout finish and waits for the runner completion result", async () => {
        vi.useFakeTimers()
        let resolveRun: ((result: SubagentExecResult) => void) | undefined
        const runner: SubagentRunnerLike = {
            run: vi.fn(
                () =>
                    new Promise<SubagentExecResult>((resolve) => {
                        resolveRun = resolve
                    }),
            ),
            abort: vi.fn().mockResolvedValue(undefined),
            requestFinish: vi.fn().mockImplementation(async (reason) => {
                assert.equal(reason, "timeout")
                resolveRun?.(COMPLETED_RESULT)
                return true
            }),
        }

        const resultPromise = runSubagent({ runner, prompt: "research", timeoutSeconds: 20, onProgress: () => {} })
        await vi.advanceTimersByTimeAsync(20_000)
        const result = await resultPromise

        assert.deepEqual(result, COMPLETED_RESULT)
        assert.equal(vi.mocked(runner.requestFinish).mock.calls.length, 1)
        assert.equal(vi.mocked(runner.abort).mock.calls.length, 0)
    })
})
