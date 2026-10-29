/** Complete target-candidate inputs used by explicit Profile and Mode transitions. */
export interface ContextTransitionPreflightInput {
    projectedUsageTokens: number
    targetContextWindow: number
}

/** Explicit transitions confirm when the complete candidate reaches the target compaction trigger. */
export type ContextTransitionPreflightDecision = { kind: "commit" } | { kind: "confirm" }

/** Apply the shared effective trigger without adding another estimation tolerance. */
export function decideContextTransition(input: ContextTransitionPreflightInput): ContextTransitionPreflightDecision {
    return input.projectedUsageTokens >= input.targetContextWindow ? { kind: "confirm" } : { kind: "commit" }
}
