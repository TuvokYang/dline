import type { CompactTriggerOptions } from "./context-window-utils"
import { resolveTargetContextScope, shouldContinueTargetWindowFitting } from "./target-context-scope"

export interface DecideTargetWindowFittingInput extends CompactTriggerOptions {
    candidateEstimatedTokens: number
    providerContextWindow: number
    hasMoreTurns: boolean
}

export type TargetWindowFittingDecisionStatus = "continue" | "complete"

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
    return {
        // Compaction stops below 80% of the window, or once nothing uncompacted
        // is left. Long tasks need compaction to keep working, so running out of
        // turns lands what was condensed instead of failing the task.
        status: mustContinue && input.hasMoreTurns ? "continue" : "complete",
        projectedUsageTokens,
        targetContextWindow: scope.targetContextWindow,
        effectiveContextLimit: scope.effectiveContextLimit,
        fittingExitTarget: scope.fittingExitTarget,
    }
}

function normalizeCandidateTokens(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
