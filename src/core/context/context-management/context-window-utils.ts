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
 * Share of the reserve the last complete turn of a Pass may take.
 *
 * The turn that crosses T usually overshoots it by a little. Splitting it off into another Pass
 * would strand most of the window and replay that turn as a fresh prefix, losing prompt-cache
 * reuse, so it may take up to half of the reserve; the other half stays for the summary.
 */
const LAST_TURN_RESERVE_SHARE = 0.5

export interface CompactTriggerOptions {
    triggerPercent?: number
    minReserveTokens?: number
    maxReserveTokens?: number
    maxContextTokens?: number
}

/**
 * The context window the user works in: the absolute cap when one is set below
 * the model window, otherwise the model window. Compaction stops once the
 * request falls below 80% of it, and one round's tool results are budgeted
 * against what it still has room for.
 */
export function resolveConfiguredContextWindow(contextWindow: number, options: CompactTriggerOptions = {}): number {
    const modelWindow = Math.max(0, Math.floor(contextWindow))
    const cap = normalizeAutoCondenseMaxContextTokens(options.maxContextTokens)
    return cap > 0 && modelWindow > cap ? cap : modelWindow
}

export type CompactTriggerBranch = "percentage_guarded" | "absolute_cap"

export interface CompactTriggerPolicy {
    branch: CompactTriggerBranch
    guardedReserveTokens: number
    effectiveContextLimitTokens: number
    hardPassContextWindowTokens: number
    /** The window the user works in; see `resolveConfiguredContextWindow`. */
    configuredContextWindowTokens: number
    projectedUsageTriggerTokens: number
    compactTriggerTokens: number
    /**
     * Maximum estimated input one hidden compaction Pass request may carry.
     *
     * A Pass carries no more than the trigger line T, so the reserve the user configured stays
     * free for the summary that Pass writes. A turn larger than T is split at message boundaries
     * instead of widening this ceiling; only an indivisible tool use/result unit may go beyond it.
     */
    passInputCeilingTokens: number
    /**
     * Ceiling for the last complete turn of a Pass: T plus half of the reserve.
     *
     * Turns are taken while the input stays at or below T; the one turn that crosses T may still
     * join the Pass when the input stays at or below this ceiling. No turn is added after it.
     */
    lastTurnPassInputCeilingTokens: number
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

/**
 * Resolve the single auto-condense trigger policy shared by every runtime consumer.
 *
 * Everything is measured against the window the user works in, W: the reserve is
 * `W × (100 − trigger%)` clamped to the configured bounds and stays free for the summary a
 * Pass writes, and the trigger is `W − reserve − summarize instructions − closure reserve`.
 * A Maximum context below the model window only changes W, never the formula.
 */
export function resolveCompactTriggerPolicy(
    contextWindow: number,
    summarizeInstructionBudget: number,
    options: CompactTriggerOptions = {},
): CompactTriggerPolicy {
    const normalizedContextWindow = Math.max(0, Math.floor(contextWindow))
    const normalizedInstructionBudget = Math.max(0, Math.floor(summarizeInstructionBudget))
    const configuredContextWindowTokens = resolveConfiguredContextWindow(normalizedContextWindow, options)

    const triggerPercent = normalizeAutoCondenseTriggerPercent(options.triggerPercent)
    const percentageReserveTokens = Math.floor((configuredContextWindowTokens * (100 - triggerPercent)) / 100)
    const { minReserveTokens, maxReserveTokens } = normalizeAutoCondenseReservePair(
        options.minReserveTokens,
        options.maxReserveTokens,
    )
    const guardedReserveTokens = clampValue(percentageReserveTokens, minReserveTokens, maxReserveTokens)

    const effectiveContextLimitTokens = Math.max(0, configuredContextWindowTokens - guardedReserveTokens)
    const hardPassContextWindowTokens = normalizedContextWindow
    const projectedUsageTriggerTokens = Math.max(
        0,
        effectiveContextLimitTokens - normalizedInstructionBudget - COMPACTION_CLOSURE_RESERVE_TOKENS,
    )
    return {
        branch: configuredContextWindowTokens < normalizedContextWindow ? "absolute_cap" : "percentage_guarded",
        guardedReserveTokens,
        effectiveContextLimitTokens,
        hardPassContextWindowTokens,
        configuredContextWindowTokens,
        projectedUsageTriggerTokens,
        compactTriggerTokens: projectedUsageTriggerTokens + ESTIMATION_TOLERANCE,
        passInputCeilingTokens: projectedUsageTriggerTokens,
        // T plus the share, measured from W so that a window smaller than the reserve, where T
        // is clamped to zero, never lends the turn space the window does not have.
        lastTurnPassInputCeilingTokens: Math.max(
            projectedUsageTriggerTokens,
            configuredContextWindowTokens -
                (guardedReserveTokens - Math.floor(guardedReserveTokens * LAST_TURN_RESERVE_SHARE)) -
                normalizedInstructionBudget -
                COMPACTION_CLOSURE_RESERVE_TOKENS,
        ),
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
