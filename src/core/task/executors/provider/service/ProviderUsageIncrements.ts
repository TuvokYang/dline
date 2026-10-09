import type { ApiStreamUsageChunk } from "@core/api/transform/stream"
import { ApiUsageAccumulator } from "@core/api/transform/usage-accumulator"

type CountedExtra = "thoughtsTokenCount" | "webSearchRequests"

/**
 * Turn one attempt's Provider usage chunks into the increments the executor adds up.
 *
 * A usage chunk is a running snapshot of the request unless the adapter marks it
 * `usageMode: "delta"`. Forwarding snapshots unchanged would count every token the
 * Provider repeats in a later event again, so each record carries only what the
 * chunk added. `totalCost` stays the resolved request total because the executor
 * replaces rather than sums it. Create one instance per attempt: a retried attempt
 * is a separate request whose snapshots start from zero.
 */
export class ProviderUsageIncrements {
	private readonly tokens = new ApiUsageAccumulator()
	private readonly counted: Record<CountedExtra, number> = { thoughtsTokenCount: 0, webSearchRequests: 0 }
	private totalCost = 0
	private cacheUsageReported = false

	next(chunk: ApiStreamUsageChunk): Record<string, number> {
		const { delta } = this.tokens.apply(chunk)
		const isDelta = chunk.usageMode === "delta"
		if (isCount(chunk.totalCost)) this.totalCost = isDelta ? this.totalCost + chunk.totalCost : chunk.totalCost
		this.cacheUsageReported ||= chunk.cacheWriteTokens !== undefined || chunk.cacheReadTokens !== undefined
		return {
			inputTokens: delta.inputTokens,
			outputTokens: delta.outputTokens,
			cacheWriteTokens: delta.cacheWriteTokens,
			cacheReadTokens: delta.cacheReadTokens,
			cacheUsageReported: this.cacheUsageReported ? 1 : 0,
			thoughtsTokenCount: this.increment("thoughtsTokenCount", chunk.thoughtsTokenCount, isDelta),
			totalCost: this.totalCost,
			webSearchRequests: this.increment("webSearchRequests", chunk.serverToolUsage?.webSearchRequests, isDelta),
		}
	}

	private increment(key: CountedExtra, value: number | undefined, isDelta: boolean): number {
		if (!isCount(value)) return 0
		const previous = this.counted[key]
		this.counted[key] = isDelta ? previous + value : Math.max(previous, value)
		return this.counted[key] - previous
	}
}

function isCount(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
}
