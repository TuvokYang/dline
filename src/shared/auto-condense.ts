export const DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT = 97
export const MIN_AUTO_CONDENSE_TRIGGER_PERCENT = 1
export const MAX_AUTO_CONDENSE_TRIGGER_PERCENT = 97
export const DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS = 5_000
export const DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS = 30_000
export const DEFAULT_AUTO_CONDENSE_MAX_CONTEXT_TOKENS = 0
export const MAX_AUTO_CONDENSE_CONTEXT_TOKENS = 2_147_483_647

export interface AutoCondenseReservePair {
    minReserveTokens: number
    maxReserveTokens: number
}

export function isValidAutoCondenseTokenSetting(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_AUTO_CONDENSE_CONTEXT_TOKENS
}

export function isValidAutoCondenseReservePair(minReserveTokens: unknown, maxReserveTokens: unknown): boolean {
    return (
        isValidAutoCondenseTokenSetting(minReserveTokens) &&
        isValidAutoCondenseTokenSetting(maxReserveTokens) &&
        minReserveTokens <= maxReserveTokens
    )
}

export function normalizeAutoCondenseTriggerPercent(value: unknown): number {
    const numericValue = Number(value)
    if (!Number.isFinite(numericValue)) {
        return DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT
    }
    return Math.min(Math.max(Math.round(numericValue), MIN_AUTO_CONDENSE_TRIGGER_PERCENT), MAX_AUTO_CONDENSE_TRIGGER_PERCENT)
}

export function normalizeAutoCondenseReserveTokens(value: unknown, fallback: number): number {
    const numericValue = Number(value)
    if (!Number.isFinite(numericValue) || numericValue < 0) {
        return fallback
    }
    return Math.min(Math.floor(numericValue), MAX_AUTO_CONDENSE_CONTEXT_TOKENS)
}

export function normalizeAutoCondenseReservePair(minValue: unknown, maxValue: unknown): AutoCondenseReservePair {
    const minReserveTokens = normalizeAutoCondenseReserveTokens(minValue, DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS)
    const maxReserveTokens = normalizeAutoCondenseReserveTokens(maxValue, DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS)
    if (minReserveTokens > maxReserveTokens) {
        return {
            minReserveTokens: DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS,
            maxReserveTokens: DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS,
        }
    }
    return { minReserveTokens, maxReserveTokens }
}

export function normalizeAutoCondenseMaxContextTokens(value: unknown): number {
    const numericValue = Number(value)
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return DEFAULT_AUTO_CONDENSE_MAX_CONTEXT_TOKENS
    }
    return Math.min(Math.floor(numericValue), MAX_AUTO_CONDENSE_CONTEXT_TOKENS)
}
