import type { ContextWindowRequestPressure } from "./context-window-projection"

export interface TokenEstimateScope {
    readonly providerId?: string
    readonly modelId?: string
    readonly apiFormat?: number
}

const MAX_RECENT_SAMPLES = 9
/**
 * Ratios no tokenizer produces for text. Usage outside this range describes
 * something other than the request bytes - a test double, hidden provider
 * input, or a row whose usage and estimate belong to different requests - and
 * learning from it would scale every later estimate by the same error.
 */
export const MIN_PLAUSIBLE_TOKEN_PER_BYTE = 0.1
export const MAX_PLAUSIBLE_TOKEN_PER_BYTE = 1

/**
 * Resolve text tokens per UTF-8 byte from exact input usage reported by one Provider scope.
 *
 * Mixed-media samples are excluded because images and documents use independent token models;
 * including them would distort every later text estimate. Implausible ratios are excluded for
 * the same reason.
 */
export function resolveTokenPerByte(
    pressures: readonly ContextWindowRequestPressure[],
    scope: TokenEstimateScope,
): number | undefined {
    const samples = pressures
        .filter((pressure) => sameScope(pressure, scope))
        .filter((pressure) => pressure.estimatedMediaTokens === 0)
        .flatMap((pressure) => {
            const bytes = positive(pressure.estimatedTextBytes)
            const tokens = positive(pressure.actualInputTokens)
            return bytes > 0 && tokens > 0 ? [tokens / bytes] : []
        })
        .filter(isPlausibleTokenPerByte)
        .slice(-MAX_RECENT_SAMPLES)
        .sort((left, right) => left - right)

    if (samples.length === 0) return undefined
    const middle = Math.floor(samples.length / 2)
    return samples.length % 2 === 1 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2
}

function sameScope(pressure: ContextWindowRequestPressure, scope: TokenEstimateScope): boolean {
    return (
        pressure.providerId === scope.providerId && pressure.modelId === scope.modelId && pressure.apiFormat === scope.apiFormat
    )
}

function isPlausibleTokenPerByte(ratio: number): boolean {
    return ratio >= MIN_PLAUSIBLE_TOKEN_PER_BYTE && ratio <= MAX_PLAUSIBLE_TOKEN_PER_BYTE
}

function positive(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}
