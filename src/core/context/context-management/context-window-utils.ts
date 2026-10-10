import { ApiHandler } from "@core/api"
import {
    DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS,
    DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS,
    normalizeAutoCondenseMaxContextTokens,
    normalizeAutoCondenseReservePair,
    normalizeAutoCondenseTriggerPercent,
} from "@shared/auto-condense"

const SAFETY_BUFFER_RATIO = 0.03
const SUMMARIZE_INSTRUCTION_BUDGET = 2_500
const ESTIMATION_TOLERANCE = 2_000
export const COMPACTION_CLOSURE_RESERVE_TOKENS = 3_000
/**
 * Smallest output space a hidden Pass request must leave inside the provider's hard context window.
 *
 * The real output ceiling is resolved per request by the window budget, which subtracts the
 * concession already spent by the input. This constant only keeps the Pass ceiling strictly
 * inside the window so a request can never claim the entire context.
 */
export const MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS = 1

export interface CompactTriggerOptions {
    triggerPercent?: number
    minReserveTokens?: number
    maxReserveTokens?: number
    maxContextTokens?: number
}

export type CompactTriggerBranch = "percentage_guarded" | "absolute_cap"

export interface CompactTriggerPolicy {
    branch: CompactTriggerBranch
    guardedReserveTokens: number
    effectiveContextLimitTokens: number
    hardPassContextWindowTokens: number
    projectedUsageTriggerTokens: number
    compactTriggerTokens: number
    /**
     * Maximum estimated input one hidden compaction Pass request may carry.
     *
     * This is derived from the provider's hard context window, not from the ordinary-request
     * trigger or an optional auto-condense cap. Those settings decide when compaction starts and
     * how small its landed target should be; they must not truncate a hidden Pass the provider can hold.
     */
    passInputCeilingTokens: number
    /** Diagnostic headroom between the ordinary-request trigger and the hidden Pass ceiling. */
    passInputCeilingAllowanceTokens: number
}

interface CompactionPassCeiling {
    allowanceTokens: number
    passInputCeilingTokens: number
}

/** Resolve the hidden Pass ceiling from the provider's hard window. */
function resolveCompactionPassCeiling(
    projectedUsageTriggerTokens: number,
    hardPassContextWindowTokens: number,
): CompactionPassCeiling {
    const passInputCeilingTokens = Math.max(
        0,
        hardPassContextWindowTokens - COMPACTION_CLOSURE_RESERVE_TOKENS - MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS,
    )
    return {
        allowanceTokens: Math.max(0, passInputCeilingTokens - projectedUsageTriggerTokens),
        passInputCeilingTokens,
    }
}

/**
 * Clamp a numeric value between lower and upper bounds.
 *
 * @param value The candidate value to clamp.
 * @param lower The inclusive lower bound.
 * @param upper The inclusive upper bound.
 * @returns The clamped numeric value.
 */
function clampValue(value: number, lower: number, upper: number): number {
    return Math.min(Math.max(value, lower), upper)
}

/**
 * Compute the safety buffer reserved for summarize-task request overhead.
 *
 * @param contextWindow The raw input context window in tokens.
 * @returns The safety buffer, equal to 3% clamped to 5k..30k tokens.
 */
export function computeSafetyBuffer(contextWindow: number): number {
    return clampValue(
        Math.floor(contextWindow * SAFETY_BUFFER_RATIO),
        DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS,
        DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS,
    )
}

/**
 * Compute the input-token budget for injected summarize_task instructions.
 *
 * @returns The fixed summarize-task instruction budget in input tokens.
 */
export function computeSummarizeBudget(): number {
    return SUMMARIZE_INSTRUCTION_BUDGET
}

/** Return the fixed tolerance reserved for request-token estimation error. */
export function getEstimationTolerance(): number {
    return ESTIMATION_TOLERANCE
}

/** Decide whether projected usage reaches the proactive trigger after estimation tolerance. */
export function shouldCompactProjectedUsage(projectedUsage: number, triggerTokens: number): boolean {
    return projectedUsage + ESTIMATION_TOLERANCE >= triggerTokens
}

/** Resolve the single auto-condense trigger policy shared by every runtime consumer. */
export function resolveCompactTriggerPolicy(
    contextWindow: number,
    summarizeInstructionBudget: number,
    options: CompactTriggerOptions = {},
): CompactTriggerPolicy {
    const normalizedContextWindow = Math.max(0, Math.floor(contextWindow))
    const normalizedInstructionBudget = Math.max(0, Math.floor(summarizeInstructionBudget))
    const maxContextTokens = normalizeAutoCondenseMaxContextTokens(options.maxContextTokens)
    if (maxContextTokens > 0 && normalizedContextWindow > maxContextTokens) {
        const effectiveContextLimitTokens = maxContextTokens
        const hardPassContextWindowTokens = normalizedContextWindow
        const projectedUsageTriggerTokens = Math.max(
            0,
            effectiveContextLimitTokens - normalizedInstructionBudget - COMPACTION_CLOSURE_RESERVE_TOKENS,
        )
        const passCeiling = resolveCompactionPassCeiling(projectedUsageTriggerTokens, hardPassContextWindowTokens)
        return {
            branch: "absolute_cap",
            guardedReserveTokens: 0,
            effectiveContextLimitTokens,
            hardPassContextWindowTokens,
            projectedUsageTriggerTokens,
            compactTriggerTokens: projectedUsageTriggerTokens + ESTIMATION_TOLERANCE,
            passInputCeilingTokens: passCeiling.passInputCeilingTokens,
            passInputCeilingAllowanceTokens: passCeiling.allowanceTokens,
        }
    }

    const triggerPercent = normalizeAutoCondenseTriggerPercent(options.triggerPercent)
    const percentageReserveTokens = Math.floor((normalizedContextWindow * (100 - triggerPercent)) / 100)
    const { minReserveTokens, maxReserveTokens } = normalizeAutoCondenseReservePair(
        options.minReserveTokens,
        options.maxReserveTokens,
    )
    const guardedReserveTokens = clampValue(percentageReserveTokens, minReserveTokens, maxReserveTokens)

    const effectiveContextLimitTokens = Math.max(0, normalizedContextWindow - guardedReserveTokens)
    const hardPassContextWindowTokens = normalizedContextWindow
    const projectedUsageTriggerTokens = Math.max(
        0,
        effectiveContextLimitTokens - normalizedInstructionBudget - COMPACTION_CLOSURE_RESERVE_TOKENS,
    )
    const passCeiling = resolveCompactionPassCeiling(projectedUsageTriggerTokens, hardPassContextWindowTokens)
    return {
        branch: "percentage_guarded",
        guardedReserveTokens,
        effectiveContextLimitTokens,
        hardPassContextWindowTokens,
        projectedUsageTriggerTokens,
        compactTriggerTokens: projectedUsageTriggerTokens + ESTIMATION_TOLERANCE,
        passInputCeilingTokens: passCeiling.passInputCeilingTokens,
        passInputCeilingAllowanceTokens: passCeiling.allowanceTokens,
    }
}

/** Compute the token threshold where proactive compaction should start. */
export function computeCompactTrigger(
    contextWindow: number,
    summarizeInstructionBudget: number,
    options: CompactTriggerOptions = {},
): number {
    return resolveCompactTriggerPolicy(contextWindow, summarizeInstructionBudget, options).compactTriggerTokens
}

/**
 * Computes the effective max allowed token count for a given context window size.
 * Pure computation — does NOT require an ApiHandler instance.
 *
 * @param contextWindow The raw context window size in tokens
 * @returns The max allowed size (contextWindow minus buffer)
 */
export function computeMaxAllowedSize(contextWindow: number): number {
    switch (contextWindow) {
        case 64_000: // deepseek models
            return contextWindow - 27_000
        case 128_000: // most models
            return contextWindow - 30_000
        case 200_000: // claude models
            return contextWindow - 40_000
        default:
            return Math.max(contextWindow - 40_000, contextWindow * 0.8)
    }
}

/**
 * Gets context window information for the given API handler
 *
 * @param api The API handler to get context window information for
 * @returns An object containing the raw context window size and the effective max allowed size
 */
export function getContextWindowInfo(api: ApiHandler) {
    const contextWindow = api.getModel().info.capabilities?.contextWindow || 128_000
    const maxAllowedSize = computeMaxAllowedSize(contextWindow)

    return { contextWindow, maxAllowedSize }
}
