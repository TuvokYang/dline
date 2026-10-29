import type { ContextBudgetLease } from "@core/context/context-management/context-budget-ledger"
import { renderPrompt } from "@core/prompts/i18n"

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

/** How the final result reaches the main task. */
export type FinalResultDelivery = "inline" | "held_until_compaction"

/** The main task's tool-result budget for its current turn, which the final result draws its share from. */
export interface MainTaskRoundBudget {
    readonly budgetTokens: number
    readonly usedTokens: number
    readonly workingConsumers: number
}

/** What a subagent is told about the room its final result may take. */
export interface SubagentContextBudgetFacts {
    readonly finalResultTokens: number
    readonly delivery: FinalResultDelivery
    /** Absent without a main-task budget, and once the result is held whole, because no share applies then. */
    readonly mainTaskRound?: MainTaskRoundBudget
}

export function describeContextBudget(
    budget: ContextBudgetLease | undefined,
    configuredTokens: number,
): SubagentContextBudgetFacts {
    if (!budget) return { finalResultTokens: configuredTokens, delivery: "inline" }
    const snapshot = budget.snapshot()
    if (snapshot.mustYield) return { finalResultTokens: configuredTokens, delivery: "held_until_compaction" }
    return {
        finalResultTokens: resolveFinalResultTokens(configuredTokens, budget),
        delivery: "inline",
        mainTaskRound: {
            budgetTokens: snapshot.roundBudgetTokens,
            usedTokens: snapshot.roundStagedTokens,
            workingConsumers: snapshot.activeConsumers,
        },
    }
}

/**
 * The section every request of a subagent carries.
 *
 * Rendered per request rather than once in the task prompt, because the share
 * moves while the subagent works: other subagents finish, and their results
 * take room from the main task. It is the only place the final-result figure
 * appears, so it is rendered even without a main-task budget.
 *
 * The round figures belong to the main task, not to the subagent's own
 * requests, so the text ties them to the final output only.
 */
export function buildContextBudgetSection(budget: ContextBudgetLease | undefined, configuredTokens: number): string {
    return renderContextBudgetSection(describeContextBudget(budget, configuredTokens))
}

export function renderContextBudgetSection(facts: SubagentContextBudgetFacts): string {
    const lines = [
        renderPrompt("subagent", "contextBudgetFinalResult", {
            FINAL_RESULT_TOKENS: facts.finalResultTokens.toLocaleString(),
        }),
    ]
    if (facts.mainTaskRound) {
        lines.push(
            renderPrompt("subagent", "contextBudgetMainTaskShare", {
                ROUND_BUDGET_TOKENS: facts.mainTaskRound.budgetTokens.toLocaleString(),
                ROUND_USED_TOKENS: facts.mainTaskRound.usedTokens.toLocaleString(),
                WORKING_CONSUMERS: String(facts.mainTaskRound.workingConsumers),
            }),
        )
    }
    if (facts.delivery === "held_until_compaction") {
        lines.push(renderPrompt("subagent", "contextBudgetHeldWhole"))
    }
    return lines.join("\n")
}
