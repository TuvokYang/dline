import { bindProviderAttemptScope, observeProviderStream, type ProviderAttemptIdentity } from "@shared/provider-attempt-observer"
import { describe, expect, it } from "vitest"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import { type ApiRequestRoundHandle, ApiRequestRoundTracker } from "./api-request-round-tracker"
import type { ApiRequestRoundRecord, ApiRequestRoundRepository } from "./api-request-round-types"
import { ApiResponseExecutionLifecycle } from "./api-response-execution-lifecycle"
import type { ApiResponseExecutionRecord, ApiResponseExecutionRepository } from "./api-response-execution-types"
import type { FinalizedProviderAttempt } from "./provider-request-round-port"

class MemoryExecutionRepository implements ApiResponseExecutionRepository {
    readonly records: ApiResponseExecutionRecord[] = []
    closed = false
    failRecovery = false

    async append(records: readonly ApiResponseExecutionRecord[]): Promise<void> {
        this.records.push(...records)
    }
    async readRecent(): Promise<ApiResponseExecutionRecord[]> {
        if (this.failRecovery) throw new Error("execution recovery failed")
        return []
    }
    async readRange(): Promise<ApiResponseExecutionRecord[]> {
        return []
    }
    async readRangeSnapshot(): Promise<ApiResponseExecutionRecord[]> {
        return []
    }
    async waitForWrites(): Promise<void> {}
    async close(): Promise<void> {
        this.closed = true
    }
}

class MemoryRoundRepository implements ApiRequestRoundRepository {
    readonly records: ApiRequestRoundRecord[] = []
    closed = false
    recoveredInputTokens: number | undefined

    async append(records: readonly ApiRequestRoundRecord[]): Promise<void> {
        this.records.push(...records)
    }
    async readRecent(): Promise<ApiRequestRoundRecord[]> {
        return []
    }
    async readRange(): Promise<ApiRequestRoundRecord[]> {
        return []
    }
    async readRangeSnapshot(): Promise<ApiRequestRoundRecord[]> {
        return []
    }
    async readRecentHistory(): Promise<ApiRequestRoundRecord[]> {
        return []
    }
    async readRangeHistorySnapshot(): Promise<ApiRequestRoundRecord[]> {
        return []
    }
    async readCumulativeUsage() {
        return {
            degraded: false,
            ...(this.recoveredInputTokens === undefined ? {} : { inputTokens: this.recoveredInputTokens }),
            cacheNumerator: 0,
            cacheDenominator: 0,
        }
    }
    isDegraded(): boolean {
        return false
    }
    async waitForWrites(): Promise<void> {}
    async close(): Promise<void> {
        this.closed = true
    }
}

describe("ApiRequestRoundLifecycle", () => {
    it("attaches late exact usage through the exact attempt handle and finalizes only its highest revision", async () => {
        const repository = new MemoryRoundRepository()
        const finalized: FinalizedProviderAttempt[] = []
        const lifecycle = new ApiRequestRoundLifecycle(new ApiRequestRoundTracker({ taskId: "task-a", repository }), undefined, {
            recordFinalizedAttempt: (attempt) => finalized.push(attempt),
        })
        const identity: ProviderAttemptIdentity = {
            provider: "anthropic",
            modelId: "catalog:claude-opus-4-1",
            thinking: "level:high",
        }
        const observer = lifecycle.createObserver({
            logicalRequestId: "review-request",
            apiIndex: 4,
            taskAttempt: 2,
            role: "reviewer",
            policyGeneration: 12,
        })
        const handle = await observer.beginAttempt(identity)
        await observer.finishAttempt(handle, "completed")

        lifecycle.attachExactUsage(handle, {
            inputTokens: 1200,
            outputTokens: 300,
            thoughtsTokens: 40,
            cacheReadTokens: 54_000,
            cacheWriteTokens: 2_100,
            cacheUsageReported: true,
        })
        lifecycle.completeProviderOnly("review-request")
        await lifecycle.close()

        expect(handle).toMatchObject({ role: "reviewer", policyGeneration: 12, ...identity })
        expect(repository.records).toHaveLength(2)
        expect(repository.records.at(-1)).toMatchObject({ revision: 1, inputTokens: 1200, outputTokens: 300 })
        expect(finalized).toEqual([
            expect.objectContaining({ handle, record: expect.objectContaining({ revision: 1, inputTokens: 1200 }) }),
        ])
        expect(() => lifecycle.attachExactUsage(handle, { inputTokens: 1, outputTokens: 1, cacheUsageReported: false })).toThrow(
            /finalized/i,
        )
    })

    it("persists transport retries separately and attaches exact usage to the last completed send", async () => {
        const repository = new MemoryRoundRepository()
        let wall = 1_000
        let monotonic = 10
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({ taskId: "task-a", repository, wallClock: () => wall, monotonicClock: () => monotonic }),
        )
        const logicalRequestId = "task-a:api:7"
        const handles: ApiRequestRoundHandle[] = []
        const lifecycleObserver = lifecycle.createObserver({ logicalRequestId, apiIndex: 7, taskAttempt: 2 })
        const observer = {
            beginAttempt: async (identity?: ProviderAttemptIdentity) => {
                const handle = await lifecycleObserver.beginAttempt(identity)
                handles.push(handle)
                return handle
            },
            finishAttempt: (handle: ApiRequestRoundHandle, status: "completed" | "failed" | "cancelled" | "aborted") =>
                lifecycleObserver.finishAttempt(handle, status),
        }
        const source = (async function* () {
            await expect(
                observeProviderStream(async () => {
                    monotonic = 20
                    throw new Error("retryable")
                }),
            ).rejects.toThrow("retryable")
            const stream = await observeProviderStream(async function* () {
                monotonic = 30
                yield "done"
                wall = 3_000
                monotonic = 2_030
            })
            for await (const value of stream) yield value
        })()
        for await (const _value of bindProviderAttemptScope(source, observer)) {
            // Drain the scoped Provider request.
        }
        const finalHandle = handles.at(-1)
        if (!finalHandle) throw new Error("Expected final Provider attempt handle")
        lifecycle.attachExactUsage(finalHandle, {
            inputTokens: 100,
            outputTokens: 20,
            cacheWriteTokens: 10,
            cacheReadTokens: 30,
            cacheUsageReported: true,
            totalCost: 0.01,
            currency: "USD",
        })
        lifecycle.completeProviderOnly(logicalRequestId)
        await lifecycle.close()

        expect(repository.records).toHaveLength(3)
        expect(
            repository.records.map(({ providerAttempt, revision, status }) => ({ providerAttempt, revision, status })),
        ).toEqual([
            { providerAttempt: 0, revision: 0, status: "failed" },
            { providerAttempt: 1, revision: 0, status: "completed" },
            { providerAttempt: 1, revision: 1, status: "completed" },
        ])
        expect(repository.records.at(-1)).toMatchObject({ taskAttempt: 2, currency: "USD", cacheReadTokens: 30 })
        expect(repository.closed).toBe(true)
    })

    it("keeps retry backoff out of execution duration and exposes the final completed send to Task coordination", async () => {
        const roundRepository = new MemoryRoundRepository()
        const executionRepository = new MemoryExecutionRepository()
        let wall = 1_000
        let monotonic = 100
        const executions = new ApiResponseExecutionLifecycle({
            taskId: "task-a",
            repository: executionRepository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })
        const finalized: FinalizedProviderAttempt[] = []
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({
                taskId: "task-a",
                repository: roundRepository,
                wallClock: () => wall,
                monotonicClock: () => monotonic,
            }),
            executions,
            { recordFinalizedAttempt: (attempt) => finalized.push(attempt) },
        )
        const logicalRequestId = "task-a:api:9"
        const observer = lifecycle.createObserver({ logicalRequestId, apiIndex: 9, taskAttempt: 0 })

        const first = await observer.beginAttempt()
        wall = 3_000
        monotonic = 2_100
        await observer.finishAttempt(first, "completed")

        wall = 13_000
        monotonic = 12_100
        const second = await observer.beginAttempt()
        wall = 15_000
        monotonic = 14_100
        await observer.finishAttempt(second, "completed")
        wall = 23_000
        monotonic = 22_100
        lifecycle.completeTools(
            logicalRequestId,
            {
                toolCount: 1,
                completedToolCount: 1,
                failedToolCount: 0,
                cancelledToolCount: 0,
            },
            [{ outcome: "completed", toolName: "read_file" }],
        )
        await lifecycle.close()

        expect(executionRepository.records).toEqual([
            expect.objectContaining({
                executionId: first.roundId,
                terminalKind: "provider_only",
                providerDurationMs: 2_000,
                executionDurationMs: 2_000,
            }),
            expect.objectContaining({
                executionId: second.roundId,
                terminalKind: "tools_settled",
                providerDurationMs: 2_000,
                executionDurationMs: 10_000,
            }),
        ])
        expect(finalized).toHaveLength(2)
        expect(finalized[0]).toMatchObject({ handle: first, record: { roundId: first.roundId } })
        expect(finalized[0].logicalExecution).toBeUndefined()
        expect(finalized[1]).toMatchObject({
            handle: second,
            record: { roundId: second.roundId },
            logicalExecution: {
                executionId: second.roundId,
                terminalKind: "tools_settled",
                toolCount: 1,
                completedToolCount: 1,
            },
            logicalToolCalls: [{ outcome: "completed", toolName: "read_file" }],
        })
        expect(executionRepository.closed).toBe(true)
    })

    it("finalizes an open send as one aborted attempt during close", async () => {
        const repository = new MemoryRoundRepository()
        const finalized: FinalizedProviderAttempt[] = []
        const lifecycle = new ApiRequestRoundLifecycle(new ApiRequestRoundTracker({ taskId: "task-a", repository }), undefined, {
            recordFinalizedAttempt: (attempt) => finalized.push(attempt),
        })
        const observer = lifecycle.createObserver({ logicalRequestId: "open-request", apiIndex: 5, taskAttempt: 0 })
        const handle = await observer.beginAttempt({
            provider: "openai",
            modelId: "catalog:gpt-5",
            thinking: "level:high",
        })

        await lifecycle.close()

        expect(finalized).toEqual([
            { handle, record: expect.objectContaining({ roundId: handle.roundId, revision: 0, status: "aborted" }) },
        ])
    })

    it("recovers round usage independently when execution recovery fails", async () => {
        const roundRepository = new MemoryRoundRepository()
        roundRepository.recoveredInputTokens = 400
        const executionRepository = new MemoryExecutionRepository()
        executionRepository.failRecovery = true
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({ taskId: "task-a", repository: roundRepository }),
            new ApiResponseExecutionLifecycle({ taskId: "task-a", repository: executionRepository }),
        )

        await lifecycle.initializeRounds()
        await expect(lifecycle.initializeExecutions()).rejects.toThrow("execution recovery failed")

        expect(lifecycle.getSnapshot()).toMatchObject({ totalTokensIn: 400 })
        expect(lifecycle.getExecutionSnapshot()).toMatchObject({ rpmBasis: "unavailable", degraded: true })
    })

    it("attaches exact usage to the latest terminal send regardless of terminal status", async () => {
        const repository = new MemoryRoundRepository()
        let wall = 1_000
        let monotonic = 10
        const lifecycle = new ApiRequestRoundLifecycle(
            new ApiRequestRoundTracker({ taskId: "task-a", repository, wallClock: () => wall, monotonicClock: () => monotonic }),
        )
        const logicalRequestId = "task-a:api:8"
        const observer = lifecycle.createObserver({ logicalRequestId, apiIndex: 8, taskAttempt: 0 })

        for (const [index, status] of (["failed", "cancelled", "aborted"] as const).entries()) {
            const handle = await observer.beginAttempt()
            wall += 100
            monotonic += 25
            await observer.finishAttempt(handle, status)
            lifecycle.attachExactUsage(handle, {
                inputTokens: 100 + index,
                outputTokens: 20 + index,
                cacheUsageReported: false,
            })
        }
        await lifecycle.close()

        expect(
            repository.records.map(({ providerAttempt, revision, status }) => ({ providerAttempt, revision, status })),
        ).toEqual([
            { providerAttempt: 0, revision: 0, status: "failed" },
            { providerAttempt: 0, revision: 1, status: "failed" },
            { providerAttempt: 1, revision: 0, status: "cancelled" },
            { providerAttempt: 1, revision: 1, status: "cancelled" },
            { providerAttempt: 2, revision: 0, status: "aborted" },
            { providerAttempt: 2, revision: 1, status: "aborted" },
        ])
    })
})
