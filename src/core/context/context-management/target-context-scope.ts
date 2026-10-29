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
        targetContextWindow: policy.configuredContextWindowTokens,
        effectiveContextLimit: policy.effectiveContextLimitTokens,
        // The same value the ordinary request gate uses, so a profile or mode switch
        // compacts at exactly the trigger line T the Auto Compact settings define.
        compactTriggerTokens: policy.compactTriggerTokens,
        // Compaction stops once the request is below 80% of the window the user works in.
        fittingExitTarget: Math.floor(policy.configuredContextWindowTokens * FITTING_EXIT_RATIO),
    }
}

/** Continue fitting while the complete target candidate is at or above the exit target. */
export function shouldContinueTargetWindowFitting(projectedUsageTokens: number, scope: TargetContextScope): boolean {
    return normalizePositiveInteger(projectedUsageTokens) >= scope.fittingExitTarget
}

function normalizePositiveInteger(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
