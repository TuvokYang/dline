import { Logger } from "@shared/services/Logger"
import type { ApiRateMetricsQuery, ApiRateMetricsQueryResult } from "./api-rate-metrics-types"
import { aggregateRoundBuckets, createRoundMetricPoints } from "./api-request-round-aggregator"
import type { ApiRequestRoundRepository } from "./api-request-round-types"
import {
    aggregateExecutionBuckets,
    createExecutionMetricPoints,
    mergeExecutionAndRoundPoints,
    mergeExecutionAndTaskRatePoints,
} from "./api-response-execution-aggregator"
import type { ApiResponseExecutionRepository } from "./api-response-execution-types"
import type { TaskRateMetricPoint, TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "./task-rate-metrics-types"

const MAX_QUERY_POINTS = 512
const MAX_RECENT_ROUNDS = 60
const MILLISECONDS_PER_SECOND = 1_000

interface ActiveRateMetricsQueryPort {
    query(query: ApiRateMetricsQuery): Promise<ApiRateMetricsQueryResult>
}

interface TaskRateMetricsQueryServiceOptions {
    activeMetrics: ActiveRateMetricsQueryPort
    roundRepository: ApiRequestRoundRepository
    executionRepository: ApiResponseExecutionRepository
    waitForRoundPersistence: () => Promise<void>
    waitForExecutionPersistence: () => Promise<void>
    isExecutionDegraded: () => boolean
    taskId: string
}

/** Combines provider-active-second TPM, canonical round usage, and complete-execution RPM facts. */
export class TaskRateMetricsQueryService {
    constructor(private readonly options: TaskRateMetricsQueryServiceOptions) {}

    async query(query: TaskRateMetricsQuery): Promise<TaskRateMetricsQueryResult> {
        assertQuery(query)
        const maxPoints = Math.min(MAX_QUERY_POINTS, Math.max(1, Math.trunc(query.maxPoints ?? MAX_QUERY_POINTS)))
        if (query.resolution === "round") return this.queryRounds(maxPoints)

        const active = await this.options.activeMetrics.query({
            resolution: query.resolution,
            startSecond: Math.floor(query.startMs / MILLISECONDS_PER_SECOND),
            endSecond: Math.ceil(query.endMs / MILLISECONDS_PER_SECOND),
            maxPoints: MAX_QUERY_POINTS,
        })
        let roundDegraded = false
        let executionDegraded = this.options.isExecutionDegraded()
        let roundPoints: TaskRateMetricPoint[] = []
        let executionPoints: TaskRateMetricPoint[] = []
        try {
            await this.options.waitForRoundPersistence()
            const rounds = await this.options.roundRepository.readRangeHistorySnapshot({
                startMs: query.startMs,
                endMs: query.endMs,
                pageSize: MAX_QUERY_POINTS,
            })
            roundPoints = aggregateRoundBuckets(rounds, query.resolution, query.startMs, query.endMs)
        } catch (error) {
            roundDegraded = true
            Logger.warn(`[Task ${this.options.taskId}] Failed to read Provider rounds; returning other metrics`, error)
        }
        if (!executionDegraded) {
            try {
                await this.options.waitForExecutionPersistence()
                executionDegraded = this.options.isExecutionDegraded()
                if (!executionDegraded) {
                    const executions = await this.options.executionRepository.readRangeSnapshot({
                        startMs: query.startMs,
                        endMs: query.endMs,
                        pageSize: MAX_QUERY_POINTS,
                    })
                    executionPoints = aggregateExecutionBuckets(executions, query.resolution, query.startMs, query.endMs)
                }
            } catch (error) {
                executionDegraded = true
                Logger.warn(`[Task ${this.options.taskId}] Failed to read complete executions; RPM is unavailable`, error)
            }
        }
        const merged = mergeExecutionAndTaskRatePoints(roundPoints, executionPoints, active.points)
        const truncated = active.truncated || merged.length > maxPoints
        const points = truncated ? merged.slice(-maxPoints) : merged
        return {
            points,
            degraded: active.degraded || roundDegraded || executionDegraded || this.options.roundRepository.isDegraded(),
            truncated,
            ...(minimumDefined(active.retentionStartMs, merged.at(0)?.bucketStartMs) === undefined
                ? {}
                : { retentionStartMs: minimumDefined(active.retentionStartMs, merged.at(0)?.bucketStartMs) }),
        }
    }

    private async queryRounds(maxPoints: number): Promise<TaskRateMetricsQueryResult> {
        const limit = Math.min(MAX_RECENT_ROUNDS, maxPoints)
        const executionDegraded = this.options.isExecutionDegraded()
        let degraded = this.options.roundRepository.isDegraded() || executionDegraded
        let rounds = [] as Awaited<ReturnType<ApiRequestRoundRepository["readRecentHistory"]>>
        let executions = [] as Awaited<ReturnType<ApiResponseExecutionRepository["readRecent"]>>
        try {
            await this.options.waitForRoundPersistence()
            rounds = await this.options.roundRepository.readRecentHistory(limit)
        } catch (error) {
            degraded = true
            Logger.warn(`[Task ${this.options.taskId}] Failed to read recent Provider rounds`, error)
        }
        if (!executionDegraded) {
            try {
                await this.options.waitForExecutionPersistence()
                if (!this.options.isExecutionDegraded()) {
                    executions = await this.options.executionRepository.readRecent(limit)
                } else {
                    degraded = true
                }
            } catch (error) {
                degraded = true
                Logger.warn(`[Task ${this.options.taskId}] Failed to read recent complete executions`, error)
            }
        }
        const points = mergeExecutionAndRoundPoints(
            createRoundMetricPoints(rounds, limit),
            createExecutionMetricPoints(executions, limit),
        ).slice(-limit)
        return {
            points,
            degraded,
            truncated: rounds.length > points.length || executions.length > points.length,
            ...(points[0] ? { retentionStartMs: points[0].bucketStartMs } : {}),
        }
    }
}

function assertQuery(query: TaskRateMetricsQuery): void {
    if (!Number.isFinite(query.startMs) || !Number.isFinite(query.endMs) || query.endMs <= query.startMs) {
        throw new Error("Task rate metrics query requires an increasing finite millisecond range")
    }
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
    if (left === undefined) return right
    if (right === undefined) return left
    return Math.min(left, right)
}
