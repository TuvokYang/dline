import { describe, expect, it } from "vitest"
import { resolveTokenPerByte } from "../token-estimation"

const SCOPE = { providerId: "oca", modelId: "claude-sonnet", apiFormat: 1 }

describe("token estimation", () => {
	it("uses the median exact text ratio for the same provider scope", () => {
		const tokenPerByte = resolveTokenPerByte(
			[
				{ ...SCOPE, estimatedTextBytes: 1_000, estimatedMediaTokens: 0, actualInputTokens: 200 },
				{ ...SCOPE, estimatedTextBytes: 1_000, estimatedMediaTokens: 0, actualInputTokens: 180 },
				{ ...SCOPE, estimatedTextBytes: 1_000, estimatedMediaTokens: 0, actualInputTokens: 190 },
			],
			SCOPE,
		)

		expect(tokenPerByte).toBe(0.19)
	})

	it("excludes mixed-media and different-provider samples", () => {
		const tokenPerByte = resolveTokenPerByte(
			[
				{ ...SCOPE, estimatedTextBytes: 1_000, estimatedMediaTokens: 600, actualInputTokens: 900 },
				{
					providerId: "other",
					modelId: SCOPE.modelId,
					apiFormat: SCOPE.apiFormat,
					estimatedTextBytes: 1_000,
					estimatedMediaTokens: 0,
					actualInputTokens: 100,
				},
			],
			SCOPE,
		)

		expect(tokenPerByte).toBeUndefined()
	})
})
