import type { ApiRateSnapshot } from "./api-rate-tracker"

export const API_RATE_METRICS_SCHEMA_VERSION = 1 as const

export class ApiRateMetricsFileIntegrityError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ApiRateMetricsFileIntegrityError"
	}
}

export class ApiRateMetricsHardLimitError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ApiRateMetricsHardLimitError"
	}
}

export type ApiRateSignal = "task_active" | "provider_active" | "request_start" | "stream_tokens" | "exact_usage"
export type ApiRateTokenQuality = "estimated" | "mixed" | "exact"
export type ApiRateMetricsResolution = "minute" | "hour" | "day"

export interface ApiRateMetricsMetaRecord {
	schemaVersion: typeof API_RATE_METRICS_SCHEMA_VERSION
	kind: "meta"
	taskId: string
	createdAt: number
}

export interface ApiRateSecondRecord {
	schemaVersion: typeof API_RATE_METRICS_SCHEMA_VERSION
	kind: "second"
	second: number
	revision: number
	signals: ApiRateSignal[]
	requestCount: number
	estimatedTokens: number
	effectiveTokens: number
	tokenQuality: ApiRateTokenQuality
	runningActiveSeconds: number
	runningProviderActiveSeconds?: number
	runningRequestCount: number
	runningTokenCount: number
	requestsPerMinute: number
	tokensPerMinute: number
}

export interface ApiRateRollupRecord {
	schemaVersion: typeof API_RATE_METRICS_SCHEMA_VERSION
	kind: "rollup"
	resolution: ApiRateMetricsResolution
	bucketStartSecond: number
	bucketSeconds: number
	activeSeconds: number
	providerActiveSeconds?: number
	requestCount: number
	tokenCount: number
	requestsPerMinute: number
	tokensPerMinute: number
	tokenQuality: ApiRateTokenQuality
}

export type ApiRateMetricsDataRecord = ApiRateSecondRecord | ApiRateRollupRecord
export type ApiRateMetricsFileRecord = ApiRateMetricsMetaRecord | ApiRateMetricsDataRecord

export interface ApiRateActivitySeconds {
	activeSeconds: number
	providerActiveSeconds: number
}

/** Count sparse API-active seconds while ignoring task-only work between Provider requests. */
export function getApiRateSecondActivitySeconds(signals: readonly ApiRateSignal[]): ApiRateActivitySeconds {
	const providerActive =
		signals.includes("provider_active") ||
		signals.includes("request_start") ||
		signals.includes("stream_tokens") ||
		signals.includes("exact_usage")
	return {
		activeSeconds: providerActive ? 1 : 0,
		providerActiveSeconds: providerActive ? 1 : 0,
	}
}

export interface ApiRateRunningState {
	activeSeconds: number
	requestCount: number
	tokenCount: number
	lastActiveSecond?: number
}

export interface ApiRateMetricsRecovery extends ApiRateRunningState {
	snapshot: ApiRateSnapshot
	degraded: boolean
	lastRecord?: ApiRateSecondRecord
	recentRecords?: ApiRateSecondRecord[]
}

export interface ApiRateMetricsReadResult {
	records: ApiRateMetricsDataRecord[]
	degraded: boolean
	storageBytes: number
	logicalRecordCount: number
	physicalRecordCount?: number
}

export interface ApiRateMetricPoint {
	bucketStartMs: number
	bucketEndMs: number
	activeSeconds: number
	requestCount: number
	tokenCount: number
	requestsPerMinute: number
	tokensPerMinute: number
	tokenQuality: ApiRateTokenQuality
	provisional?: boolean
}

export interface ApiRateMetricsQuery {
	resolution: ApiRateMetricsResolution
	startSecond: number
	endSecond: number
	maxPoints?: number
}

export interface ApiRateMetricsQueryResult {
	points: ApiRateMetricPoint[]
	degraded: boolean
	truncated: boolean
	retentionStartMs?: number
}

/**
 * Exact provider usage that feeds TPM. TPM is a generation rate over provider-active seconds, so only
 * generated output counts; prompt and cache tokens are read before streaming starts and would inflate it.
 */
export interface ApiRateExactUsage {
	/** Generated tokens reported by the provider, already including any reasoning share. */
	outputTokens: number
}

export interface ApiRateMetricsRangeQuery {
	startSecond: number
	endSecond: number
}

export interface ApiRateMetricsRepository {
	initialize(): Promise<ApiRateMetricsRecovery>
	append(records: readonly ApiRateMetricsDataRecord[]): Promise<void>
	readAll(): Promise<ApiRateMetricsReadResult>
	readRange(query: ApiRateMetricsRangeQuery): Promise<ApiRateMetricsReadResult>
	replaceAll(records: readonly ApiRateMetricsDataRecord[]): Promise<void>
	compactIfNeeded(nowSecond: number): Promise<boolean>
	waitForWrites(): Promise<void>
	close(): Promise<void>
}
