import { type CompactTriggerOptions, computeSummarizeBudget, resolveCompactTriggerPolicy } from "./context-window-utils"

export interface TargetContextScopeInput extends CompactTriggerOptions {
    providerContextWindow: number
}

export interface TargetContextScope {
    targetContextWindow: number
    effectiveContextLimit: number
    compactTriggerTokens: number
    fittingExitTarget: number
}

const FITTING_EXIT_RATIO = 0.8

/** Resolve the effective ordinary-request context window and its strict fitting exit target. */
export function resolveTargetContextScope(input: TargetContextScopeInput): TargetContextScope {
    const providerContextWindow = normalizePositiveInteger(input.providerContextWindow)
    if (providerContextWindow === 0) {
        throw new Error("Target provider context window must be positive")
    }
    const policy = resolveCompactTriggerPolicy(providerContextWindow, computeSummarizeBudget(), input)
    return {
        targetContextWindow: policy.hardPassContextWindowTokens,
        effectiveContextLimit: policy.effectiveContextLimitTokens,
        compactTriggerTokens: policy.projectedUsageTriggerTokens,
        fittingExitTarget: Math.floor(policy.effectiveContextLimitTokens * FITTING_EXIT_RATIO),
    }
}

/** Continue fitting while the complete target candidate is at or above the exit target. */
export function shouldContinueTargetWindowFitting(projectedUsageTokens: number, scope: TargetContextScope): boolean {
    return normalizePositiveInteger(projectedUsageTokens) >= scope.fittingExitTarget
}

function normalizePositiveInteger(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
