import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { clampThinkingBudget } from "./thinking-budget"

const BUDGET_STEP = 1_024

/** Select a legal positive budget without treating the Chat disable sentinel as a preference. */
export function resolveOpenCodeThinkingBudget(thinking: NonNullable<ModelCapabilities["thinking"]>, budget?: number): number {
    if (budget !== undefined && clampThinkingBudget(budget, thinking) === budget) return budget
    return Math.max(1, thinking.minBudget ?? Math.min(BUDGET_STEP, thinking.maxBudget ?? BUDGET_STEP))
}

/** Offer declared budget steps and retain a valid stored preference between those steps. */
export function openCodeThinkingBudgetOptions(
    thinking: NonNullable<ModelCapabilities["thinking"]>,
    budget?: number,
): readonly number[] {
    const minimum = resolveOpenCodeThinkingBudget(thinking)
    const maximum = thinking.maxBudget ?? minimum
    const options = new Set<number>([resolveOpenCodeThinkingBudget(thinking, budget)])
    for (let value = minimum; value <= maximum; value += BUDGET_STEP) options.add(value)
    return [...options].sort((left, right) => left - right)
}

/** OpenCode defaults are client policy, not facts to write into the remote catalog. */
export function resolveOpenCodeReasoningConfig(
    capabilities: ModelCapabilities | undefined,
    stored: ReasoningConfig | undefined,
): ReasoningConfig | undefined {
    const thinking = capabilities?.thinking
    if (capabilities?.supportsReasoning === false || thinking?.supported !== true) return stored ? { ...stored } : undefined
    const levels = thinking.effortLevels ?? []
    const defaultEffort = thinking.mode === "effort" ? levels[Math.max(0, levels.length - 2)] : undefined
    return {
        ...stored,
        enableThinking: stored?.enableThinking ?? true,
        effort: stored?.effort ?? defaultEffort,
    }
}
