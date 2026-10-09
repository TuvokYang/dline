import type { CompactTriggerOptions } from "./context-window-utils"
import { resolveTargetContextScope, shouldContinueTargetWindowFitting } from "./target-context-scope"

export interface DecideTargetWindowFittingInput extends CompactTriggerOptions {
	candidateEstimatedTokens: number
	providerContextWindow: number
	hasMoreTurns: boolean
}

export type TargetWindowFittingDecisionStatus = "continue" | "complete" | "exhausted"

export interface TargetWindowFittingDecision {
	status: TargetWindowFittingDecisionStatus
	projectedUsageTokens: number
	targetContextWindow: number
	effectiveContextLimit: number
	fittingExitTarget: number
}

/** Decide whether the fully rebuilt ordinary target candidate has converged. */
export function decideTargetWindowFitting(input: DecideTargetWindowFittingInput): TargetWindowFittingDecision {
	const scope = resolveTargetContextScope(input)
	const projectedUsageTokens = normalizeCandidateTokens(input.candidateEstimatedTokens)
	const mustContinue = shouldContinueTargetWindowFitting(projectedUsageTokens, scope)
	const exceedsHardWindow = projectedUsageTokens >= scope.targetContextWindow
	return {
		// The 80% boundary is the target for another iterative Pass, not a final
		// validity gate. Once no complete turn remains, landing a request that still
		// fits the hard window is strictly better than discarding the summary and
		// terminating the task. Only a candidate the provider cannot hold is exhausted.
		status: mustContinue && input.hasMoreTurns ? "continue" : exceedsHardWindow ? "exhausted" : "complete",
		projectedUsageTokens,
		targetContextWindow: scope.targetContextWindow,
		effectiveContextLimit: scope.effectiveContextLimit,
		fittingExitTarget: scope.fittingExitTarget,
	}
}

function normalizeCandidateTokens(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
