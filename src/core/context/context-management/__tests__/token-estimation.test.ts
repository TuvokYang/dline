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

    it("excludes different-provider samples and rows without a media estimate", () => {
        const tokenPerByte = resolveTokenPerByte(
            [
                { ...SCOPE, estimatedTextBytes: 1_000, actualInputTokens: 300 },
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

    // A screenshot stays in the history, so every later request carries media; dropping those
    // samples left such a task uncalibrated and its estimates a quarter token per byte.
    it("measures the text share of a request that also carries media", () => {
        const tokenPerByte = resolveTokenPerByte(
            [
                { ...SCOPE, estimatedTextBytes: 1_000_000, estimatedMediaTokens: 1_600, actualInputTokens: 341_600 },
                { ...SCOPE, estimatedTextBytes: 1_000, estimatedMediaTokens: 900, actualInputTokens: 900 },
            ],
            SCOPE,
        )

        expect(tokenPerByte).toBe(0.34)
    })

    it("ignores ratios no tokenizer produces, such as 13.5 tokens per byte", () => {
        const sample = (actualInputTokens: number) => ({
            ...SCOPE,
            estimatedTextBytes: 1_000,
            estimatedMediaTokens: 0,
            actualInputTokens,
        })

        expect(resolveTokenPerByte([sample(13_500), sample(50)], SCOPE)).toBeUndefined()
        expect(resolveTokenPerByte([sample(13_500), sample(250), sample(50)], SCOPE)).toBe(0.25)
        expect(resolveTokenPerByte([sample(1_000), sample(100)], SCOPE)).toBe(0.55)
    })
})
