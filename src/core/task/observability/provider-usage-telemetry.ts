import type { ApiFormat } from "@shared/proto/dline/models/metadata"
import { getTelemetryServiceSync } from "@/services/telemetry"

/** An authoritative Provider request usage fact, emitted after the request settles. */
export interface ProviderUsageTelemetryRecord {
	readonly taskUlid: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheWriteTokens: number
	readonly cacheReadTokens: number
	readonly cacheUsageReported: boolean
	readonly thoughtsTokens?: number
	readonly totalCost?: number
	readonly provider: string
	readonly model: string
	readonly apiFormat?: ApiFormat
}

/** Keeps request settlement independent from the telemetry backend and delivery policy. */
export interface ProviderUsageTelemetryPort {
	record(usage: ProviderUsageTelemetryRecord): void
}

/** Default local projection; consent and provider fan-out remain owned by TelemetryService. */
export const providerUsageTelemetry: ProviderUsageTelemetryPort = {
	record: (usage) => {
		getTelemetryServiceSync().captureTokenUsage(
			usage.taskUlid,
			usage.inputTokens,
			usage.outputTokens,
			usage.provider,
			usage.model,
			{
				cacheWriteTokens: usage.cacheWriteTokens,
				cacheReadTokens: usage.cacheReadTokens,
				cacheUsageReported: usage.cacheUsageReported,
				...(usage.thoughtsTokens === undefined ? {} : { thoughtsTokens: usage.thoughtsTokens }),
				...(usage.totalCost === undefined ? {} : { totalCost: usage.totalCost }),
				...(usage.apiFormat === undefined ? {} : { apiFormat: usage.apiFormat }),
			},
		)
	},
}
