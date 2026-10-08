import { afterEach, describe, expect, it, vi } from "vitest"
import { foldApiRateSecondRevisions } from "./api-rate-metrics-aggregator"
import {
	API_RATE_METRICS_SCHEMA_VERSION,
	type ApiRateMetricsDataRecord,
	ApiRateMetricsFileIntegrityError,
	type ApiRateMetricsReadResult,
	type ApiRateMetricsRecovery,
	type ApiRateMetricsRepository,
	type ApiRateSecondRecord,
} from "./api-rate-metrics-types"
import { TaskApiRateMetricsService } from "./task-api-rate-metrics-service"

class MemoryRepository implements ApiRateMetricsRepository {
	readonly records: ApiRateMetricsDataRecord[] = []
	readonly compactionRequests: number[] = []
	readonly rangeQueries: Array<{ startSecond: number; endSecond: number }> = []
	readAllCalls = 0

	constructor(private readonly recovery: ApiRateMetricsRecovery = emptyRecovery()) {}

	async initialize(): Promise<ApiRateMetricsRecovery> {
		return this.recovery
	}

	async append(records: readonly ApiRateMetricsDataRecord[]): Promise<void> {
		this.records.push(...records)
	}

	async readAll(): Promise<ApiRateMetricsReadResult> {
		this.readAllCalls += 1
		return {
			records: [...this.records],
			degraded: false,
			storageBytes: 0,
			logicalRecordCount: this.records.length,
			physicalRecordCount: this.records.length,
		}
	}

	async readRange(query: { startSecond: number; endSecond: number }): Promise<ApiRateMetricsReadResult> {
		this.rangeQueries.push(query)
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

	async compactIfNeeded(nowSecond: number): Promise<boolean> {
		this.compactionRequests.push(nowSecond)
		return false
	}

	async waitForWrites(): Promise<void> {}

	async close(): Promise<void> {}
}

class IntegrityFailureRepository extends MemoryRepository {
	override async initialize(): Promise<ApiRateMetricsRecovery> {
		throw new ApiRateMetricsFileIntegrityError("metrics Task mismatch")
	}
}

class UnavailableRepository implements ApiRateMetricsRepository {
	async initialize(): Promise<ApiRateMetricsRecovery> {
		throw new Error("metrics storage unavailable")
	}

	async append(): Promise<void> {
		throw new Error("metrics storage unavailable")
	}

	async readAll(): Promise<ApiRateMetricsReadResult> {
		throw new Error("metrics storage unavailable")
	}

	async readRange(): Promise<ApiRateMetricsReadResult> {
		throw new Error("metrics storage unavailable")
	}

	async replaceAll(): Promise<void> {
		throw new Error("metrics storage unavailable")
	}

	async compactIfNeeded(): Promise<boolean> {
		throw new Error("metrics storage unavailable")
	}

	async waitForWrites(): Promise<void> {}

	async close(): Promise<void> {}
}

function emptyRecovery(): ApiRateMetricsRecovery {
	return { activeSeconds: 0, requestCount: 0, tokenCount: 0, snapshot: {}, degraded: false }
}

function secondRecord(second: number, overrides: Partial<ApiRateSecondRecord> = {}): ApiRateSecondRecord {
	return {
		schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
		kind: "second",
		second,
		revision: 0,
		signals: ["stream_tokens"],
		requestCount: 0,
		estimatedTokens: 250,
		effectiveTokens: 250,
		tokenQuality: "exact",
		runningActiveSeconds: 1,
		runningRequestCount: 0,
		runningTokenCount: 250,
		requestsPerMinute: 0,
		tokensPerMinute: 15_000,
		...overrides,
	}
}

function secondRecords(repository: MemoryRepository): ApiRateSecondRecord[] {
	return repository.records.filter((record): record is ApiRateSecondRecord => record.kind === "second")
}

afterEach(() => {
	vi.useRealTimers()
})

describe("TaskApiRateMetricsService", () => {
	it("rejects file integrity failures instead of silently replacing another Task history", async () => {
		const service = new TaskApiRateMetricsService({ repository: new IntegrityFailureRepository(), taskId: "task-a" })

		await expect(service.initialize()).rejects.toThrow(ApiRateMetricsFileIntegrityError)
		service.recordRequestStarted()
		expect(service.getSnapshot()).toEqual({})
	})

	it("continues with live metrics and degraded history when initialization fails", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"))
		const service = new TaskApiRateMetricsService({ repository: new UnavailableRepository(), taskId: "task-a" })

		await expect(service.initialize()).resolves.toBeUndefined()
		service.recordRequestStarted()
		service.recordEstimatedTokens(120)

		expect(service.getSnapshot()).toEqual({ activeSeconds: 1, requestsPerMinute: 60, tokensPerMinute: 7_200 })
		await expect(
			service.query({ resolution: "minute", startSecond: 1_786_356_000, endSecond: 1_786_356_060 }),
		).resolves.toMatchObject({ degraded: true, points: [expect.objectContaining({ tokenCount: 120, provisional: true })] })
	})

	it("pushes ordinary history queries into the repository range API", async () => {
		const repository = new MemoryRepository()
		repository.records.push(secondRecord(10), secondRecord(70))
		const service = new TaskApiRateMetricsService({ repository, taskId: "task-a" })
		await service.initialize()

		await service.query({ resolution: "minute", startSecond: 0, endSecond: 60 })

		expect(repository.rangeQueries).toEqual([{ startSecond: 0, endSecond: 60 }])
		expect(repository.readAllCalls).toBe(0)
	})

	it("writes one record for an active second and performs no idle writes", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"))
		const repository = new MemoryRepository()
		const service = new TaskApiRateMetricsService({ repository })
		await service.initialize()

		service.recordRequestStarted()
		service.recordEstimatedTokens(50)
		service.recordEstimatedTokens(70)
		service.recordProviderRequestFinished()
		expect(repository.records).toHaveLength(0)

		await vi.advanceTimersByTimeAsync(1_001)
		await service.waitForPersistence()

		expect(secondRecords(repository)).toEqual([
			expect.objectContaining({
				schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
				revision: 0,
				signals: ["provider_active", "request_start", "stream_tokens"],
				requestCount: 1,
				estimatedTokens: 120,
				effectiveTokens: 120,
				runningActiveSeconds: 1,
				runningProviderActiveSeconds: 1,
				runningRequestCount: 1,
				runningTokenCount: 120,
				requestsPerMinute: 60,
				tokensPerMinute: 7_200,
			}),
		])
		expect(service.getSnapshot()).toEqual({ activeSeconds: 1, requestsPerMinute: 60, tokensPerMinute: 7_200 })

		await vi.advanceTimersByTimeAsync(120_000)
		await service.waitForPersistence()
		expect(secondRecords(repository)).toHaveLength(1)
	})

	it("counts only API-active seconds for RPM while excluding task work and later idle time", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"))
		const repository = new MemoryRepository()
		const service = new TaskApiRateMetricsService({ repository })
		await service.initialize()
		service.setTaskLoopActive(true)

		for (let index = 0; index < 61; index += 1) {
			service.recordRequestStarted()
			service.recordEstimatedTokens(index === 0 ? 1_000 : 10)
			service.recordProviderRequestFinished()
			await vi.advanceTimersByTimeAsync(10_000)
		}
		service.setTaskLoopActive(false)
		await service.waitForPersistence()

		const workingSnapshot = {
			activeSeconds: 60,
			requestsPerMinute: 60,
			tokensPerMinute: 600,
		}
		expect(service.getSnapshot()).toEqual(workingSnapshot)
		expect(secondRecords(repository)).toHaveLength(61)

		await vi.advanceTimersByTimeAsync(120_000)
		expect(service.getSnapshot()).toEqual(workingSnapshot)
	})

	it("appends revisions that replace estimates with exact request usage", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"))
		const repository = new MemoryRepository()
		const service = new TaskApiRateMetricsService({ repository })
		await service.initialize()

		service.recordRequestStarted()
		service.recordEstimatedTokens(30)
		await vi.advanceTimersByTimeAsync(1_001)
		service.recordEstimatedTokens(70)
		await vi.advanceTimersByTimeAsync(1_001)
		service.recordProviderRequestFinished()
		service.recordExactUsage({ outputTokens: 200 })
		await vi.advanceTimersByTimeAsync(1_001)
		await service.waitForPersistence()

		const canonical = foldApiRateSecondRevisions(secondRecords(repository))
		expect(
			canonical.map(({ second, revision, effectiveTokens, tokenQuality }) => ({
				second,
				revision,
				effectiveTokens,
				tokenQuality,
			})),
		).toEqual([
			{ second: 1_786_356_000, revision: 1, effectiveTokens: 60, tokenQuality: "exact" },
			{ second: 1_786_356_001, revision: 1, effectiveTokens: 140, tokenQuality: "exact" },
			{ second: 1_786_356_002, revision: 1, effectiveTokens: 0, tokenQuality: "exact" },
		])
		expect(canonical.at(-1)).toMatchObject({
			runningActiveSeconds: 3,
			runningProviderActiveSeconds: 3,
			runningRequestCount: 1,
			runningTokenCount: 200,
			requestsPerMinute: 20,
			tokensPerMinute: 4_000,
		})
	})

	it("counts only generated output tokens toward TPM when exact usage includes prompt and cache tokens", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"))
		const repository = new MemoryRepository()
		const service = new TaskApiRateMetricsService({ repository })
		await service.initialize()
		// Provider usage reaches the service as the full usage object; prompt and cache tokens are
		// consumed before streaming starts, so they must not inflate the per-active-second rate.
		const providerUsage = { inputTokens: 90_000, cacheWriteTokens: 5_000, cacheReadTokens: 80_000, outputTokens: 120 }

		service.recordRequestStarted()
		service.recordEstimatedTokens(40)
		await vi.advanceTimersByTimeAsync(1_001)
		service.recordEstimatedTokens(80)
		service.recordProviderRequestFinished()
		service.recordExactUsage(providerUsage)
		await vi.advanceTimersByTimeAsync(1_001)
		await service.waitForPersistence()

		const canonical = foldApiRateSecondRevisions(secondRecords(repository))
		expect(canonical.map(({ effectiveTokens }) => effectiveTokens)).toEqual([40, 80])
		expect(canonical.at(-1)).toMatchObject({
			runningProviderActiveSeconds: 2,
			runningTokenCount: 120,
			tokensPerMinute: 3_600,
		})
		expect(service.getSnapshot().tokensPerMinute).toBe(3_600)
	})

	it("checks retention after exact usage and after the final dispose flush", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"))
		const repository = new MemoryRepository()
		const service = new TaskApiRateMetricsService({ repository })
		await service.initialize()

		service.recordRequestStarted()
		service.recordEstimatedTokens(50)
		service.recordProviderRequestFinished()
		service.recordExactUsage({ outputTokens: 50 })
		await service.waitForPersistence()
		expect(repository.compactionRequests).toEqual([1_786_356_000])

		await service.dispose()
		expect(repository.compactionRequests).toEqual([1_786_356_000, 1_786_356_000])
	})

	it("restores the persisted running state before accepting new activity", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-10T10:00:01.000Z"))
		const recentRecords = [
			secondRecord(1_786_355_997, { requestCount: 1 }),
			secondRecord(1_786_355_998),
			secondRecord(1_786_355_999, { requestCount: 1 }),
			secondRecord(1_786_356_000),
		]
		const repository = new MemoryRepository({
			activeSeconds: 4,
			requestCount: 2,
			tokenCount: 1_000,
			lastActiveSecond: 1_786_356_000,
			snapshot: { activeSeconds: 4, requestsPerMinute: 30, tokensPerMinute: 15_000 },
			degraded: false,
			lastRecord: recentRecords.at(-1),
			recentRecords,
		})
		const service = new TaskApiRateMetricsService({ repository })

		await service.initialize()
		expect(service.getSnapshot()).toEqual({ activeSeconds: 4, requestsPerMinute: 30, tokensPerMinute: 15_000 })

		service.recordRequestStarted()
		expect(service.getSnapshot()).toEqual({ activeSeconds: 5, requestsPerMinute: 36, tokensPerMinute: 12_000 })
	})
})
