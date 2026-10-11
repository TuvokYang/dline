import type { ContextBudgetLease } from "@core/context/context-management/context-budget-ledger"

/** The subagent output estimator's bytes per token, so a byte share converts the way results are measured. */
const SUBAGENT_ESTIMATE_BYTES_PER_TOKEN = 4

/**
 * Tokens the final result may take right now.
 *
 * The configured output budget, but never more than this subagent's share of
 * the round's tool result budget, `(B − round staged) ÷ working calls`: parallel
 * subagents split it, and a result that already returned has made it smaller
 * for the rest. The shares of all calls together never exceed the round's budget.
 *
 * Once the main task must yield, the result is not delivered inline at all: it
 * is held whole and released after compaction. Cutting it to the share first
 * would hold almost nothing, so only the configured budget applies then.
 */
export function resolveFinalResultTokens(configuredTokens: number, budget: ContextBudgetLease | undefined): number {
    if (!budget || budget.snapshot().mustYield) return configuredTokens
    const shareTokens = Math.floor(budget.shareBytes(Number.MAX_SAFE_INTEGER) / SUBAGENT_ESTIMATE_BYTES_PER_TOKEN)
    return Math.min(configuredTokens, shareTokens)
}

/**
 * The section every request of a subagent carries.
 *
 * Rendered per request rather than once in the task prompt, because the share
 * moves while the subagent works: other subagents finish, and their results
 * take room from the main task.
 */
export function buildContextBudgetSection(budget: ContextBudgetLease | undefined, configuredTokens: number): string | undefined {
    if (!budget) return undefined
    const snapshot = budget.snapshot()
    return [
        "# Context Budget",
        `Your final result may use about ${resolveFinalResultTokens(configuredTokens, budget).toLocaleString()} tokens.`,
        `This round's tool results may take ${snapshot.roundBudgetTokens.toLocaleString()} tokens together; ${snapshot.roundStagedTokens.toLocaleString()} are already used, and the rest is shared by ${snapshot.activeConsumers} working subagent(s) and tool call(s).`,
        snapshot.mustYield
            ? "The main task is out of room: your final result will be held whole and delivered after the main task compacts its context."
            : "This budget shrinks as other subagents return; keep the final result within it.",
    ].join("\n")
}
