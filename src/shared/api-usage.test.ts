import { describe, expect, it } from "vitest"
import { calculateApiUsageStatistics } from "./api-usage"

describe("calculateApiUsageStatistics", () => {
	it("derives total tokens and the token-weighted cache hit rate", () => {
		expect(
			calculateApiUsageStatistics({
				inputTokens: 120,
				outputTokens: 80,
				cacheWriteTokens: 50,
				cacheReadTokens: 30,
				thoughtsTokens: 20,
			}),
		).toEqual({
			totalInputTokens: 200,
			// Thoughts (20) are a share of output, not an additional term.
			totalTokens: 280,
			cacheHit: true,
			cacheHitRatePercent: 15,
		})
	})

	it("returns a zero cache rate when no input-side tokens exist", () => {
		expect(calculateApiUsageStatistics({ inputTokens: 0, outputTokens: 7 })).toEqual({
			totalInputTokens: 0,
			totalTokens: 7,
			cacheHit: false,
			cacheHitRatePercent: 0,
		})
	})

	it("ignores invalid and negative provider values", () => {
		expect(
			calculateApiUsageStatistics({
				inputTokens: Number.NaN,
				outputTokens: -5,
				cacheWriteTokens: Number.POSITIVE_INFINITY,
				cacheReadTokens: -10,
			}),
		).toEqual({
			totalInputTokens: 0,
			totalTokens: 0,
			cacheHit: false,
			cacheHitRatePercent: 0,
		})
	})
})
