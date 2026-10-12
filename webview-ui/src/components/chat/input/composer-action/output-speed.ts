/**
 * How fast the running model writes its answer, in coarse tiers the composer's
 * action button can show at a glance.
 *
 * Each tier starts at its floor and runs up to the next one:
 *
 * | Tier        | Output tokens per second |
 * |-------------|--------------------------|
 * | `slow`      | below 50                 |
 * | `moderate`  | 50 up to 100             |
 * | `fast`      | 100 up to 200            |
 * | `very_fast` | 200 and above            |
 */
export type OutputSpeedTier = "slow" | "moderate" | "fast" | "very_fast"

/** The lowest output rate, in tokens per second, that reaches each tier above `slow`. */
export const OUTPUT_SPEED_TIER_FLOORS = {
    moderate: 50,
    fast: 100,
    very_fast: 200,
} as const satisfies Record<Exclude<OutputSpeedTier, "slow">, number>

/** The tier an output rate falls in; a rate that is not a finite number counts as slow. */
export function outputSpeedTier(tokensPerSecond: number): OutputSpeedTier {
    if (!Number.isFinite(tokensPerSecond) || tokensPerSecond < OUTPUT_SPEED_TIER_FLOORS.moderate) return "slow"
    if (tokensPerSecond < OUTPUT_SPEED_TIER_FLOORS.fast) return "moderate"
    if (tokensPerSecond < OUTPUT_SPEED_TIER_FLOORS.very_fast) return "fast"
    return "very_fast"
}

/**
 * The per-second rate behind a tokens-per-minute figure such as the task
 * header's TPM; absent while there is no figure to convert.
 */
export function tokensPerSecondFromPerMinute(tokensPerMinute: number | undefined): number | undefined {
    if (tokensPerMinute === undefined || !Number.isFinite(tokensPerMinute)) return undefined
    return Math.max(0, tokensPerMinute) / 60
}

/** The rate as the tooltip states it, rounded to whole tokens per second. */
export function formatOutputSpeed(tokensPerSecond: number): string {
    const rate = Number.isFinite(tokensPerSecond) ? Math.max(0, Math.round(tokensPerSecond)) : 0
    return `${rate} tokens/s`
}
