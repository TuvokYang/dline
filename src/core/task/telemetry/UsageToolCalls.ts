import type { BlockPhase } from "../kernel"

/** The three outcomes one settled tool call can be reported under. */
export const USAGE_TOOL_CALL_OUTCOMES = ["completed", "failed", "cancelled"] as const
export type UsageToolCallOutcome = (typeof USAGE_TOOL_CALL_OUTCOMES)[number]

/** One tool call the turn settled, as usage reports it. */
export interface UsageToolCall {
    readonly outcome: UsageToolCallOutcome
    /** The registered tool identity, absent when the call could not be resolved to one. */
    readonly toolName?: string
}

/**
 * Classify one settled block.
 *
 * This is the single classification the task uses: the response-execution
 * counters and the usage tool counters both read it, so `by_name` plus
 * `unlisted` can never disagree with the totals the same block contributed to.
 *
 * A block whose result the user is answering counts as completed because the
 * turn ended on it, which is what the execution record already reports.
 */
export function toolCallOutcome(phase: BlockPhase, awaited: boolean): UsageToolCallOutcome {
    if (awaited || phase === "completed") return "completed"
    // A rejected block never ran, but it settled without a result, which is a failure.
    if (phase === "failed" || phase === "rejected") return "failed"
    return "cancelled"
}

/** Whether a call was resolved to a tool identity worth naming on the wire. */
export function namesTool(call: UsageToolCall): boolean {
    return call.toolName !== undefined && call.toolName.length > 0
}

/** Sum tool calls into the three outcome totals they must account for. */
export function countToolCallOutcomes(calls: readonly UsageToolCall[]): Readonly<Record<UsageToolCallOutcome, number>> {
    const totals = { completed: 0, failed: 0, cancelled: 0 }
    for (const call of calls) totals[call.outcome] += 1
    return totals
}
