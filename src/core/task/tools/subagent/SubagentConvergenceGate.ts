import type { SubagentFinishReason } from "./SubagentExecutor"

/**
 * Fraction of the subagent context window that forces convergence.
 *
 * Beyond this point the run can no longer collect useful new material: the
 * remaining window has to carry the final result. Hardcoded on purpose — this
 * is a runtime safety bound, not a user preference.
 */
export const CONTEXT_CONVERGENCE_THRESHOLD = 0.8

/** Percentage form used in operator-facing prompt text. */
export const CONTEXT_CONVERGENCE_THRESHOLD_PERCENT = Math.round(CONTEXT_CONVERGENCE_THRESHOLD * 100)

/** Observed context occupancy of one subagent run. */
export interface ContextPressureSample {
    readonly contextTokens: number
    readonly contextWindow: number
}

/**
 * Decide whether observed context usage requires forced convergence.
 *
 * An unknown window (zero or negative) yields false: without a capacity there
 * is no meaningful ratio, and guessing would abort runs on providers that do
 * not report a window.
 */
export function exceedsContextConvergenceThreshold(sample: ContextPressureSample): boolean {
    if (!Number.isFinite(sample.contextWindow) || sample.contextWindow <= 0) return false
    if (!Number.isFinite(sample.contextTokens) || sample.contextTokens <= 0) return false
    return sample.contextTokens >= sample.contextWindow * CONTEXT_CONVERGENCE_THRESHOLD
}

/** Render the context usage section injected into every subagent turn. */
export function buildContextUsageSection(sample: ContextPressureSample): string | undefined {
    if (!Number.isFinite(sample.contextWindow) || sample.contextWindow <= 0) return undefined

    const usedTokens = Math.max(0, Math.floor(sample.contextTokens))
    const usagePercentage = Math.round((usedTokens / sample.contextWindow) * 100)
    return [
        "# Context Window Usage",
        `${usedTokens.toLocaleString()} / ${(sample.contextWindow / 1000).toLocaleString()}K tokens used (${usagePercentage}%)`,
        "",
        `Call attempt_completion before usage reaches ${CONTEXT_CONVERGENCE_THRESHOLD_PERCENT}%. At that point every tool except attempt_completion is rejected, so unfinished exploration is lost.`,
    ].join("\n")
}

/** Describe why the run must converge, for the reminder injected on the next turn. */
export function describeConvergenceTrigger(reason: SubagentFinishReason): string {
    switch (reason) {
        case "timeout":
            return "The subagent time limit was reached."
        case "context_pressure":
            return `The subagent context window usage reached ${CONTEXT_CONVERGENCE_THRESHOLD_PERCENT}%.`
        default:
            return "The user requested that the subagent finish now."
    }
}

/**
 * Build the result returned when a converging run keeps calling other tools.
 *
 * A run that reached this point has usually spent significant time collecting
 * material, so discarding everything as a failure destroys real work. The
 * partial transcript is returned instead, clearly marked as incomplete.
 */
export function buildSalvagedConvergenceResult(reason: SubagentFinishReason, collectedFindings: string): string {
    const header = [
        describeConvergenceTrigger(reason),
        "The subagent did not produce a final attempt_completion result after being asked to converge.",
        "The material below was recovered from the run and is incomplete; treat every conclusion as unverified.",
    ].join(" ")

    const findings = collectedFindings.trim()
    return findings ? `${header}\n\n${findings}` : `${header}\n\nNo reusable findings were recovered from this run.`
}
