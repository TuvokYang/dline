import { describe, expect, it, vi } from "vitest"
import type { ApiRateMetricsQuery, ApiRateMetricsQueryResult } from "./api-rate-metrics-types"
import {
    API_REQUEST_ROUND_SCHEMA_VERSION,
    type ApiRequestRoundRecord,
    type ApiRequestRoundRepository,
} from "./api-request-round-types"
import type { ApiResponseExecutionRecord, ApiResponseExecutionRepository } from "./api-response-execution-types"
import { TaskRateMetricsQueryService } from "./task-rate-metrics-query-service"

function round(overrides: Partial<ApiRequestRoundRecord> = {}): ApiRequestRoundRecord {
    return {
        schemaVersion: API_REQUEST_ROUND_SCHEMA_VERSION,
        taskId: "task-a",
        roundId: "round-a",
        revision: 1,
        logicalRequestId: "request-a",
        apiIndex: 1,
        taskAttempt: 0,
        providerAttempt: 0,
        startedAtMs: 1_000,
        completedAtMs: 3_000,
        providerDurationMs: 2_000,
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

function execution(source: ApiRequestRoundRecord, executionDurationMs = 10_000): ApiResponseExecutionRecord {
    return {
        schemaVersion: 1,
        taskId: source.taskId,
        executionId: source.roundId,
        revision: 0,
        roundId: source.roundId,
        logicalRequestId: source.logicalRequestId,
        apiIndex: source.apiIndex,
        taskAttempt: source.taskAttempt,
        providerAttempt: source.providerAttempt,
        startedAtMs: source.startedAtMs,
        providerCompletedAtMs: source.completedAtMs,
        completedAtMs: source.completedAtMs + Math.max(0, executionDurationMs - (source.providerDurationMs ?? 1)),
        providerDurationMs: source.providerDurationMs ?? 1,
        executionDurationMs,
        status: source.status,
        terminalKind: "tools_settled",
        toolCount: 1,
        completedToolCount: source.status === "completed" ? 1 : 0,
        failedToolCount: source.status === "failed" ? 1 : 0,
        cancelledToolCount: source.status === "cancelled" || source.status === "aborted" ? 1 : 0,
    }
}

class MemoryExecutionRepository implements ApiResponseExecutionRepository {
    readonly readRecent = vi.fn(async (_limit?: number) => this.executions)
    readonly readRange = vi.fn(async () => this.executions)
    readonly readRangeSnapshot = vi.fn(async () => this.executions)

    constructor(readonly executions: ApiResponseExecutionRecord[]) {}

    async append(): Promise<void> {}
    async waitForWrites(): Promise<void> {}
    async close(): Promise<void> {}
}

class MemoryRoundRepository implements ApiRequestRoundRepository {
    readonly readRecent = vi.fn(async (_limit?: number) => this.rounds)
    readonly readRange = vi.fn(async () => this.rounds)
    readonly readRangeSnapshot = vi.fn(async () => this.rounds)
    readonly readRecentHistory = vi.fn(async (_limit?: number) => this.rounds)
    readonly readRangeHistorySnapshot = vi.fn(async () => this.rounds)

    constructor(readonly rounds: ApiRequestRoundRecord[]) {}

    async append(): Promise<void> {}
    async readCumulativeUsage() {
        return { degraded: false, cacheNumerator: 0, cacheDenominator: 0 }
    }
    isDegraded(): boolean {
        return false
    }
    async waitForWrites(): Promise<void> {}
    async close(): Promise<void> {}
}

function activeResult(): ApiRateMetricsQueryResult {
    return {
        points: [
            {
                bucketStartMs: 0,
                bucketEndMs: 60_000,
                activeSeconds: 2,
                requestCount: 1,
                tokenCount: 500,
                requestsPerMinute: 30,
                tokensPerMinute: 15_000,
                tokenQuality: "exact",
            },
        ],
        degraded: false,
        truncated: false,
        retentionStartMs: 0,
    }
}

describe("TaskRateMetricsQueryService", () => {
    it("returns the most recent 60 canonical rounds without querying active-second history", async () => {
        const rounds = Array.from({ length: 60 }, (_, index) =>
            round({ roundId: `round-${index}`, logicalRequestId: `request-${index}`, completedAtMs: index * 1_000 }),
        )
        const repository = new MemoryRoundRepository(rounds)
        const executionRepository = new MemoryExecutionRepository(rounds.map((record) => execution(record)))
        const activeMetrics = { query: vi.fn<(query: ApiRateMetricsQuery) => Promise<ApiRateMetricsQueryResult>>() }
        const waitForRoundPersistence = vi.fn(async () => undefined)
        const service = new TaskRateMetricsQueryService({
            activeMetrics,
            roundRepository: repository,
            executionRepository,
            waitForRoundPersistence,
            waitForExecutionPersistence: async () => undefined,
            isExecutionDegraded: () => false,
            taskId: "task-a",
        })

        const result = await service.query({ resolution: "round", startMs: 1, endMs: 60_000, maxPoints: 512 })

        expect(waitForRoundPersistence).toHaveBeenCalledOnce()
        expect(repository.readRecentHistory).toHaveBeenCalledWith(60)
        expect(repository.readRecent).not.toHaveBeenCalled()
        expect(repository.readRange).not.toHaveBeenCalled()
        expect(repository.readRangeSnapshot).not.toHaveBeenCalled()
        expect(repository.readRangeHistorySnapshot).not.toHaveBeenCalled()
        expect(activeMetrics.query).not.toHaveBeenCalled()
        expect(result.points).toHaveLength(60)
        expect(result.points[0]?.roundId).toBe("round-0")
    })

    it("merges typed active-second and round ranges while preserving TPM", async () => {
        const repository = new MemoryRoundRepository([
            round({ completedAtMs: 10_000, providerDurationMs: 2_000 }),
            round({ roundId: "round-b", logicalRequestId: "request-b", completedAtMs: 20_000, providerDurationMs: 4_000 }),
        ])
        const activeMetrics = { query: vi.fn(async () => activeResult()) }
        const executionRepository = new MemoryExecutionRepository([
            execution(repository.rounds[0]!, 10_000),
            execution(repository.rounds[1]!, 5_000),
        ])
        const service = new TaskRateMetricsQueryService({
            activeMetrics,
            roundRepository: repository,
            executionRepository,
            waitForRoundPersistence: async () => undefined,
            waitForExecutionPersistence: async () => undefined,
            isExecutionDegraded: () => false,
            taskId: "task-a",
        })

        const result = await service.query({ resolution: "minute", startMs: 0, endMs: 60_000, maxPoints: 60 })

        expect(activeMetrics.query).toHaveBeenCalledWith({
            resolution: "minute",
            startSecond: 0,
            endSecond: 60,
            maxPoints: 512,
        })
        expect(repository.readRangeHistorySnapshot).toHaveBeenCalledWith({ startMs: 0, endMs: 60_000, pageSize: 512 })
        expect(repository.readRange).not.toHaveBeenCalled()
        expect(repository.readRangeSnapshot).not.toHaveBeenCalled()
        expect(result.points[0]).toMatchObject({
            tokensPerMinute: 15_000,
            requestsPerMinute: 8,
            rpmBasis: "execution_duration",
            executionCount: 2,
            executionDurationMs: 15_000,
            providerRoundCount: 2,
        })
    })

    it("keeps legacy active-second metrics and marks the result degraded when round reads fail", async () => {
        const repository = new MemoryRoundRepository([])
        repository.readRangeHistorySnapshot.mockRejectedValueOnce(new Error("round storage unavailable"))
        const service = new TaskRateMetricsQueryService({
            activeMetrics: { query: vi.fn(async () => activeResult()) },
            roundRepository: repository,
            executionRepository: new MemoryExecutionRepository([]),
            waitForRoundPersistence: async () => undefined,
            waitForExecutionPersistence: async () => undefined,
            isExecutionDegraded: () => false,
            taskId: "task-a",
        })

        const result = await service.query({ resolution: "hour", startMs: 0, endMs: 3_600_000 })

        expect(result.degraded).toBe(true)
        expect(result.points[0]).toMatchObject({
            tokensPerMinute: 15_000,
            rpmBasis: "unavailable",
            executionCount: 0,
        })
        expect(result.points[0]?.requestsPerMinute).toBeUndefined()
    })

    it("keeps round usage but suppresses RPM when execution persistence degrades while waiting", async () => {
        const repository = new MemoryRoundRepository([round({ completedAtMs: 10_000, providerDurationMs: 2_000 })])
        let executionDegraded = false
        const service = new TaskRateMetricsQueryService({
            activeMetrics: { query: vi.fn(async () => activeResult()) },
            roundRepository: repository,
            executionRepository: new MemoryExecutionRepository([execution(repository.rounds[0]!, 10_000)]),
            waitForRoundPersistence: async () => undefined,
            waitForExecutionPersistence: async () => {
                executionDegraded = true
            },
            isExecutionDegraded: () => executionDegraded,
            taskId: "task-a",
        })

        const result = await service.query({ resolution: "minute", startMs: 0, endMs: 60_000 })

        expect(result.degraded).toBe(true)
        expect(result.points[0]).toMatchObject({
            tokensPerMinute: 15_000,
            inputTokens: 100,
            rpmBasis: "unavailable",
            executionCount: 0,
        })
        expect(result.points[0]?.requestsPerMinute).toBeUndefined()

        const roundResult = await service.query({ resolution: "round", startMs: 0, endMs: 60_000 })
        expect(roundResult.degraded).toBe(true)
        expect(roundResult.points[0]).toMatchObject({
            inputTokens: 100,
            rpmBasis: "unavailable",
            executionCount: 0,
        })
        expect(roundResult.points[0]?.requestsPerMinute).toBeUndefined()
    })

    it("aggregates every round when a bucket contains more than the 512-point response limit", async () => {
        const rounds = Array.from({ length: 600 }, (_, index) =>
            round({ roundId: `round-${index}`, logicalRequestId: `request-${index}`, providerDurationMs: 1_000 }),
        )
        const repository = new MemoryRoundRepository(rounds)
        const service = new TaskRateMetricsQueryService({
            activeMetrics: { query: vi.fn(async () => ({ ...activeResult(), points: [] })) },
            roundRepository: repository,
            executionRepository: new MemoryExecutionRepository(rounds.map((record) => execution(record, 1_000))),
            waitForRoundPersistence: async () => undefined,
            waitForExecutionPersistence: async () => undefined,
            isExecutionDegraded: () => false,
            taskId: "task-a",
        })

        const result = await service.query({ resolution: "minute", startMs: 0, endMs: 60_000, maxPoints: 60 })

        expect(repository.readRangeHistorySnapshot).toHaveBeenCalledWith({ startMs: 0, endMs: 60_000, pageSize: 512 })
        expect(result.points).toHaveLength(1)
        expect(result.points[0]).toMatchObject({ providerRoundCount: 600, executionCount: 600, requestsPerMinute: 60 })
    })
})
