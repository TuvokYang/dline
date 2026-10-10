import { describe, expect, it, vi } from "vitest"
import { calculateRoundCacheHitRate } from "./api-request-round-aggregator"
import { ApiRequestRoundTracker } from "./api-request-round-tracker"
import type { ApiRequestRoundCumulativeUsage, ApiRequestRoundRecord, ApiRequestRoundRepository } from "./api-request-round-types"

class MemoryRoundRepository implements ApiRequestRoundRepository {
    readonly records: ApiRequestRoundRecord[] = []
    readonly recentLimits: number[] = []
    closed = false

    constructor(
        private readonly recoveredRecords: ApiRequestRoundRecord[] = [],
        private readonly cumulative: ApiRequestRoundCumulativeUsage = {
            degraded: false,
            cacheNumerator: 0,
            cacheDenominator: 0,
        },
    ) {}

    async append(records: readonly ApiRequestRoundRecord[]): Promise<void> {
        this.records.push(...records)
    }

    async readRecent(limit = 60): Promise<ApiRequestRoundRecord[]> {
        this.recentLimits.push(limit)
        return this.recoveredRecords.slice(-limit)
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

    async readCumulativeUsage(): Promise<ApiRequestRoundCumulativeUsage> {
        return this.cumulative
    }

    isDegraded(): boolean {
        return false
    }

    async waitForWrites(): Promise<void> {}
    async close(): Promise<void> {
        this.closed = true
    }
}

function recoveredRound(index: number, overrides: Partial<ApiRequestRoundRecord> = {}): ApiRequestRoundRecord {
    return {
        schemaVersion: 1,
        taskId: "task-a",
        roundId: `round-${index}`,
        revision: 1,
        logicalRequestId: `request-${index}`,
        apiIndex: index,
        taskAttempt: 0,
        providerAttempt: 0,
        startedAtMs: index * 2_000,
        completedAtMs: index * 2_000 + 1_000,
        providerDurationMs: 1_000,
        status: "completed",
        inputTokens: 100,
        outputTokens: 20,
        thoughtsTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        cacheUsageReported: true,
        usageQuality: "exact",
        ...overrides,
    }
}

describe("ApiRequestRoundTracker", () => {
    it("persists one terminal duration revision and one late exact usage revision", async () => {
        const repository = new MemoryRoundRepository()
        let wall = 1_000
        let monotonic = 50
        const tracker = new ApiRequestRoundTracker({
            taskId: "task-a",
            repository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })
        const handle = tracker.beginRound({ logicalRequestId: "request-a", apiIndex: 7, taskAttempt: 0 })
        wall = 3_000
        monotonic = 2_050
        tracker.finishRound(handle, "completed")
        tracker.finishRound(handle, "failed")
        tracker.attachExactUsage(handle, {
            inputTokens: 1_200,
            outputTokens: 200,
            thoughtsTokens: 50,
            cacheWriteTokens: 100,
            cacheReadTokens: 300,
            cacheUsageReported: true,
            totalCost: 0.12,
            currency: "USD",
        })
        await tracker.waitForPersistence()

        expect(repository.records).toHaveLength(2)
        expect(repository.records[0]).toMatchObject({
            roundId: "task-a:request-a:provider:0",
            revision: 0,
            providerAttempt: 0,
            providerDurationMs: 2_000,
            status: "completed",
            cacheUsageReported: false,
            usageQuality: "none",
        })
        expect(repository.records[1]).toMatchObject({
            revision: 1,
            inputTokens: 1_200,
            outputTokens: 200,
            cacheWriteTokens: 100,
            cacheReadTokens: 300,
            cacheUsageReported: true,
            usageQuality: "exact",
        })
        expect(calculateRoundCacheHitRate(repository.records[1])).toBe(0.1875)
    })

    it("clamps duration to one millisecond and exposes weighted cumulative usage with recent duration RPM", () => {
        const repository = new MemoryRoundRepository()
        let monotonic = 100
        const onChanged = vi.fn()
        const tracker = new ApiRequestRoundTracker({
            taskId: "task-a",
            repository,
            wallClock: () => 1_000,
            monotonicClock: () => monotonic,
            onChanged,
        })
        const first = tracker.beginRound({ logicalRequestId: "request-a", apiIndex: 1, taskAttempt: 0 })
        tracker.finishRound(first, "completed")
        tracker.attachExactUsage(first, {
            inputTokens: 100,
            outputTokens: 20,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            cacheUsageReported: true,
        })
        const second = tracker.beginRound({ logicalRequestId: "request-b", apiIndex: 2, taskAttempt: 0 })
        monotonic = 1_100
        tracker.finishRound(second, "failed")
        tracker.attachExactUsage(second, {
            inputTokens: 300,
            outputTokens: 30,
            cacheWriteTokens: 100,
            cacheReadTokens: 100,
            cacheUsageReported: true,
        })

        expect(tracker.getSnapshot()).toEqual({
            requestsPerMinute: 120,
            rpmBasis: "provider_duration",
            providerRoundCount: 2,
            totalTokensIn: 400,
            totalTokensOut: 50,
            totalCacheWrites: 100,
            totalCacheReads: 100,
            cacheHitRate: (100 / 600) * 100,
            cacheUsageAvailable: true,
        })
        expect(onChanged).toHaveBeenCalledTimes(4)
    })

    it("recovers complete cumulative usage and recent duration RPM from canonical persistence", async () => {
        const repository = new MemoryRoundRepository(
            [
                recoveredRound(1, { cacheReadTokens: 50 }),
                recoveredRound(2, { cacheWriteTokens: 50, totalCost: 0.25, currency: "USD" }),
            ],
            {
                degraded: false,
                inputTokens: 200,
                outputTokens: 40,
                cacheWriteTokens: 50,
                cacheReadTokens: 50,
                cacheNumerator: 50,
                cacheDenominator: 300,
                totalCost: 0.25,
                currency: "USD",
            },
        )
        const tracker = new ApiRequestRoundTracker({ taskId: "task-a", repository })

        await tracker.initialize()

        expect(repository.recentLimits).toEqual([60])
        expect(tracker.getSnapshot()).toEqual({
            requestsPerMinute: 60,
            rpmBasis: "provider_duration",
            providerRoundCount: 2,
            totalTokensIn: 200,
            totalTokensOut: 40,
            totalCacheWrites: 50,
            totalCacheReads: 50,
            totalCost: 0.25,
            cacheHitRate: (50 / 300) * 100,
            cacheUsageAvailable: true,
            currency: "USD",
        })
    })

    it("recovers full cumulative usage while limiting RPM to the latest 60 exact rounds", async () => {
        const repository = new MemoryRoundRepository(
            Array.from({ length: 61 }, (_, index) => recoveredRound(index)),
            {
                degraded: false,
                inputTokens: 6_100,
                outputTokens: 1_220,
                cacheWriteTokens: 0,
                cacheReadTokens: 0,
                cacheNumerator: 0,
                cacheDenominator: 6_100,
            },
        )
        const tracker = new ApiRequestRoundTracker({ taskId: "task-a", repository })

        await tracker.initialize()

        expect(tracker.getSnapshot()).toEqual({
            requestsPerMinute: 60,
            rpmBasis: "provider_duration",
            providerRoundCount: 60,
            totalTokensIn: 6_100,
            totalTokensOut: 1_220,
            totalCacheWrites: 0,
            totalCacheReads: 0,
            cacheHitRate: 0,
            cacheUsageAvailable: true,
        })
    })

    it("keeps cumulative fields unavailable when repository recovery is degraded", async () => {
        const repository = new MemoryRoundRepository([recoveredRound(1)], {
            degraded: true,
            cacheNumerator: 0,
            cacheDenominator: 0,
        })
        const tracker = new ApiRequestRoundTracker({ taskId: "task-a", repository })

        await tracker.initialize()

        expect(tracker.getSnapshot()).toEqual({
            requestsPerMinute: 60,
            rpmBasis: "provider_duration",
            providerRoundCount: 1,
            cacheUsageAvailable: false,
        })
    })

    it("aborts and flushes every open round before closing the repository", async () => {
        const repository = new MemoryRoundRepository()
        let wall = 1_000
        let monotonic = 100
        const tracker = new ApiRequestRoundTracker({
            taskId: "task-a",
            repository,
            wallClock: () => wall,
            monotonicClock: () => monotonic,
        })
        const completed = tracker.beginRound({ logicalRequestId: "request-a", apiIndex: 7, taskAttempt: 0 })
        wall = 1_100
        monotonic = 150
        tracker.finishRound(completed, "completed")
        tracker.beginRound({ logicalRequestId: "request-b", apiIndex: 8, taskAttempt: 0 })
        wall = 1_300
        monotonic = 400

        await tracker.close()

        expect(
            repository.records.map(({ logicalRequestId, status, providerDurationMs }) => ({
                logicalRequestId,
                status,
                providerDurationMs,
            })),
        ).toEqual([
            { logicalRequestId: "request-a", status: "completed", providerDurationMs: 50 },
            { logicalRequestId: "request-b", status: "aborted", providerDurationMs: 250 },
        ])
        expect(repository.closed).toBe(true)
        expect(() => tracker.beginRound({ logicalRequestId: "request-c", apiIndex: 9, taskAttempt: 0 })).toThrow(
            "API request round tracker is closing",
        )
    })

    it("assigns each real send a distinct attempt and distinguishes zero from unavailable cache", async () => {
        const repository = new MemoryRoundRepository()
        let monotonic = 0
        const tracker = new ApiRequestRoundTracker({
            taskId: "task-a",
            repository,
            wallClock: () => 1_000,
            monotonicClock: () => monotonic,
        })
        const failed = tracker.beginRound({ logicalRequestId: "request-a", apiIndex: 7, taskAttempt: 0 })
        monotonic = 10
        tracker.finishRound(failed, "failed")
        const retried = tracker.beginRound({ logicalRequestId: "request-a", apiIndex: 7, taskAttempt: 0 })
        monotonic = 20
        tracker.finishRound(retried, "completed")
        tracker.attachExactUsage(retried, {
            inputTokens: 100,
            outputTokens: 10,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            cacheUsageReported: true,
        })
        await tracker.waitForPersistence()

        expect(failed.providerAttempt).toBe(0)
        expect(retried.providerAttempt).toBe(1)
        expect(calculateRoundCacheHitRate(repository.records[0])).toBeUndefined()
        const canonical = repository.records.at(-1)
        if (!canonical) throw new Error("Expected a canonical API request round")
        expect(calculateRoundCacheHitRate(canonical)).toBe(0)
    })
})
