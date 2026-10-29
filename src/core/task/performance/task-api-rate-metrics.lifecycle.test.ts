import { afterEach, describe, expect, it, vi } from "vitest"
import type {
    ApiRateMetricsDataRecord,
    ApiRateMetricsReadResult,
    ApiRateMetricsRecovery,
    ApiRateMetricsRepository,
} from "./api-rate-metrics-types"
import { TaskApiRateMetricsService } from "./task-api-rate-metrics-service"

class MemoryRepository implements ApiRateMetricsRepository {
    readonly records: ApiRateMetricsDataRecord[] = []

    async initialize(): Promise<ApiRateMetricsRecovery> {
        return { activeSeconds: 0, requestCount: 0, tokenCount: 0, snapshot: {}, degraded: false }
    }

    async append(records: readonly ApiRateMetricsDataRecord[]): Promise<void> {
        this.records.push(...records)
    }

    async readAll(): Promise<ApiRateMetricsReadResult> {
        return {
            records: [...this.records],
            degraded: false,
            storageBytes: 0,
            logicalRecordCount: this.records.length,
            physicalRecordCount: this.records.length,
        }
    }

    async readRange(query: { startSecond: number; endSecond: number }): Promise<ApiRateMetricsReadResult> {
        const records = this.records.filter((record) => {
            const startSecond = record.kind === "second" ? record.second : record.bucketStartSecond
            return startSecond >= query.startSecond && startSecond < query.endSecond
        })
        return {
            records,
            degraded: false,
            storageBytes: 0,
            logicalRecordCount: records.length,
            physicalRecordCount: records.length,
        }
    }

    async replaceAll(records: readonly ApiRateMetricsDataRecord[]): Promise<void> {
        this.records.splice(0, this.records.length, ...records)
    }

    async compactIfNeeded(): Promise<boolean> {
        return false
    }

    async waitForWrites(): Promise<void> {}

    async close(): Promise<void> {}
}

afterEach(() => {
    vi.useRealTimers()
})

describe("TaskApiRateMetricsService rate semantics", () => {
    it("counts an actual Provider request even when the broader Task loop is inactive", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-08-20T10:00:00.000Z"))
        const service = new TaskApiRateMetricsService({ repository: new MemoryRepository() })
        await service.initialize()

        service.recordRequestStarted()
        service.recordEstimatedTokens(120)
        service.recordProviderRequestFinished()

        expect(service.getSnapshot()).toEqual({
            activeSeconds: 1,
            requestsPerMinute: 60,
            tokensPerMinute: 7_200,
        })
    })

    it("uses only API-active seconds for RPM and does not persist task-only work", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-08-20T10:00:00.000Z"))
        const repository = new MemoryRepository()
        const service = new TaskApiRateMetricsService({ repository })
        await service.initialize()

        service.setTaskLoopActive(true)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(repository.records).toHaveLength(0)

        service.recordRequestStarted()
        service.recordEstimatedTokens(120)
        service.recordProviderRequestFinished()
        service.setTaskLoopActive(false)
        await service.waitForPersistence()

        expect(service.getSnapshot()).toEqual({
            activeSeconds: 1,
            requestsPerMinute: 60,
            tokensPerMinute: 7_200,
        })
        expect(repository.records).toHaveLength(1)
    })
})
