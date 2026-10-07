import { hashCompactionValue } from "./compaction-hash"
import type { PlanNextCompactionPassResult } from "./compaction-pass-planner"
import { getEstimationTolerance } from "./context-window-utils"
import type { CompactionPassIdentity, TargetWindowFittingState } from "./target-window-fitting"

export const MAX_SUMMARY_REFIT_ATTEMPTS = 2

export type SummaryCarryOverflow = Extract<PlanNextCompactionPassResult, { kind: "summary_carry_overflow" }>

/** Reserve enough exact input budget for the next turn plus the shared estimation tolerance. */
export function resolveSummaryRefitCarryLimit(result: SummaryCarryOverflow): number {
	return Math.max(0, result.passInputCeiling - result.requestEnvelopeTokens - result.turnTokens - getEstimationTolerance())
}

/** Bind one refit request to the unchanged fitting coverage and current cumulative-summary baseline. */
export function createSummaryRefitIdentity(state: TargetWindowFittingState, refitIndex: number): CompactionPassIdentity {
	const identity = {
		operationId: state.operationId,
		passIndex: state.passIndex,
		passStartTurnIndex: state.coveredTurnCount,
		passEndTurnIndex: state.coveredTurnCount - 1,
		coveredTurnCount: state.coveredTurnCount,
		summaryBaselineHash: state.summaryBaselineHash,
		sourceHistoryHash: state.sourceHistoryHash,
		passStartMessageIndex: state.passStartMessageIndex,
		passEndMessageIndex: state.passEndMessageIndex,
	}
	return {
		...identity,
		passHistoryHash: hashCompactionValue({ kind: "summary_refit", refitIndex, ...identity }),
	}
}

/** Instruct the model to rewrite only the cumulative summary within the next-Pass carry budget. */
export function buildSummaryRefitGuidance(carryLimitTokens: number, refitAttempt: number): string {
	return `# Summary Refit
Rewrite only the cumulative compaction summary supplied immediately before this instruction.
Preserve every fact required to continue the task, but remove repetition and lower-value detail.
Do not add facts, process any uncovered logical turn, or change the task state.
The complete response, including reasoning and the <summarize_task> block, has a hard limit of ${carryLimitTokens} tokens.
This is bounded refit attempt ${refitAttempt} of ${MAX_SUMMARY_REFIT_ATTEMPTS}; return a strictly smaller summary.`
}

/** Explain a terminal carry failure without misattributing the combined request to one logical turn. */
export function formatSummaryRefitFailure(result: SummaryCarryOverflow, attempts: number, carryLimitTokens: number): string {
	return (
		`Cumulative summary refit exhausted after ${attempts} attempt(s) before Pass ${result.turnIndex + 1}: ` +
		`target carry budget ${carryLimitTokens}, current carry ${result.summaryCarryTokens}, ` +
		`request envelope ${result.requestEnvelopeTokens}, logical turn ${result.turnTokens}, ` +
		`combined ${result.combinedEstimatedInputTokens}, Pass ceiling ${result.passInputCeiling}.`
	)
}
