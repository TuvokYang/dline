import type { ClineStorageMessage } from "@/shared/messages"
import { type ContextWindowCandidateEstimator, estimateContextWindowCandidateBreakdown } from "./context-window-projection"
import { COMPACTION_CLOSURE_RESERVE_TOKENS } from "./context-window-utils"

export type CompactionWindowBudgetDecision = "ready" | "needs_smaller_input"

export interface CompactionWindowBudget {
	estimatedInputTokens: number
	/** Diagnostic split of estimatedInputTokens; never used in any budget decision. */
	estimatedTextTokens: number
	/** Diagnostic split of estimatedInputTokens; never used in any budget decision. */
	estimatedImageTokens: number
	rawRemainder: number
	availableRemainder: number
	providerOutputCap: number
	closureReserveTokens: number
	reservedRequestTokens: number
	/** Backward-compatible prompt-facing alias for providerOutputCap. */
	outputHardLimit: number
	recommendedMin: number
	recommendedMax: number
	/**
	 * The requested next-Pass carry limit was too small to hold any usable summary.
	 *
	 * The carry limit is derived from the size of the *next* uncovered turn. When that turn is
	 * oversized the limit collapses toward zero, which must not silently strip the current Pass of
	 * its output budget: the current Pass may still fit comfortably and its summary is what makes
	 * progress possible. The current Pass therefore falls back to its ordinary budget and the
	 * oversized turn is reported by the planner when that turn is actually reached.
	 */
	carryLimitInfeasible: boolean
	decision: CompactionWindowBudgetDecision
}

/** Smallest carry budget that can still hold a usable cumulative summary. */
export const MIN_SUMMARY_CARRY_TOKENS = 512

export interface ResolveCompactionWindowBudgetInput {
	contextWindow: number
	maxOutputTokens?: number
	/** Optional output ceiling reserved so this summary can be carried into the next Pass. */
	summaryOutputLimitTokens?: number
	systemPrompt: string
	tools?: readonly unknown[]
	serverTools?: readonly unknown[]
	closureReserveTokens?: number
	/**
	 * Provider/model context shared with the compaction planner and the context-window indicator.
	 *
	 * All three must measure the same request with the same estimator; a divergence here makes the
	 * planner select a range that this budget then rejects, with no way for either side to converge.
	 */
	estimator?: ContextWindowCandidateEstimator
	buildMessages: (guidance: string) => ClineStorageMessage[]
}

export interface ResolvedCompactionWindowBudget {
	budget: CompactionWindowBudget
	messages: ClineStorageMessage[]
}

const MAX_RENDER_PASSES = 3

/** Resolve a request-scoped compaction budget by rebuilding only the explicit summarize_task instruction. */
export function resolveCompactionWindowBudget(input: ResolveCompactionWindowBudgetInput): ResolvedCompactionWindowBudget {
	let messages = input.buildMessages("")
	let budget = computeBudget(input, messages)

	for (let pass = 0; pass < MAX_RENDER_PASSES; pass++) {
		messages = input.buildMessages(renderBudgetGuidance(budget))
		const nextBudget = computeBudget(input, messages)
		if (
			nextBudget.estimatedInputTokens === budget.estimatedInputTokens &&
			nextBudget.outputHardLimit === budget.outputHardLimit
		) {
			budget = nextBudget
			break
		}
		budget = nextBudget
	}

	messages = input.buildMessages(renderBudgetGuidance(budget))
	budget = computeBudget(input, messages)
	return { budget, messages }
}

function computeBudget(input: ResolveCompactionWindowBudgetInput, messages: ClineStorageMessage[]): CompactionWindowBudget {
	const estimate = estimateContextWindowCandidateBreakdown(
		{
			systemPrompt: input.systemPrompt,
			messages,
			tools: input.tools ?? [],
			serverTools: input.serverTools ?? [],
		},
		input.estimator ?? {},
	)
	const estimatedInputTokens = estimate.totalTokens
	const rawRemainder = Math.floor(input.contextWindow) - estimatedInputTokens
	const availableRemainder = Math.max(0, rawRemainder)
	const closureReserveTokens = normalizeNonNegativeInteger(input.closureReserveTokens ?? COMPACTION_CLOSURE_RESERVE_TOKENS)
	const modelOutputLimit =
		typeof input.maxOutputTokens === "number" && Number.isFinite(input.maxOutputTokens) && input.maxOutputTokens > 0
			? Math.floor(input.maxOutputTokens)
			: availableRemainder
	const requestedSummaryOutputLimit =
		input.summaryOutputLimitTokens === undefined
			? Number.POSITIVE_INFINITY
			: normalizeNonNegativeInteger(input.summaryOutputLimitTokens)
	// A carry limit below the usable minimum describes the next turn, not this request. Applying it
	// here would zero this Pass's output and report a misleading "no output budget" failure.
	const carryLimitInfeasible =
		Number.isFinite(requestedSummaryOutputLimit) && requestedSummaryOutputLimit < MIN_SUMMARY_CARRY_TOKENS
	const summaryOutputLimit = carryLimitInfeasible ? Number.POSITIVE_INFINITY : requestedSummaryOutputLimit
	const providerOutputCap = Math.min(
		modelOutputLimit,
		summaryOutputLimit,
		Math.floor(availableRemainder * 0.9),
		Math.max(0, availableRemainder - closureReserveTokens),
	)
	// The recommended range must stay within the hard limit: advising a longer response than the
	// request can actually emit would guarantee truncation.
	const recommendedMax = Math.min(Math.floor(availableRemainder * 0.9), 30_000, providerOutputCap)
	const recommendedMin = Math.min(Math.floor(availableRemainder * 0.8), 5_000, recommendedMax)
	const reservedRequestTokens = estimatedInputTokens + providerOutputCap + closureReserveTokens

	return {
		estimatedInputTokens,
		estimatedTextTokens: estimate.textTokens,
		estimatedImageTokens: estimate.imageTokens,
		rawRemainder,
		availableRemainder,
		providerOutputCap,
		closureReserveTokens,
		reservedRequestTokens,
		outputHardLimit: providerOutputCap,
		recommendedMin,
		recommendedMax,
		carryLimitInfeasible,
		decision: providerOutputCap > 0 ? "ready" : "needs_smaller_input",
	}
}

function normalizeNonNegativeInteger(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function renderBudgetGuidance(budget: CompactionWindowBudget): string {
	return `# Compaction Window Budget
- Estimated available context-window remainder: ${budget.availableRemainder} tokens.
- Hard limit for the complete response: ${budget.outputHardLimit} tokens.
- Recommended total response range: ${budget.recommendedMin}–${budget.recommendedMax} tokens.

The recommended range is guidance, not a quota or a minimum output requirement.
Do not expand the analysis or summary merely to fill the available range.
Preserve all information required to continue the task accurately and completely.
The complete response, including reasoning and the <summarize_task> block, must not exceed the hard limit above.`
}
