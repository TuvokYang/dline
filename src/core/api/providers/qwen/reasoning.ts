import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { clampThinkingBudget, resolveThinkingBudgetBounds } from "@shared/providers/thinking-budget"

interface QwenThinking {
	enabled: boolean
	fields?: { enable_thinking: boolean; thinking_budget?: number }
}

/** Encode DashScope's budget switch without deriving capability or defaults from a model name. */
export function resolveQwenThinking(
	capabilities: ModelCapabilities | undefined,
	config: ReasoningConfig | undefined,
): QwenThinking {
	const thinking = capabilities?.thinking
	if (capabilities?.supportsReasoning === false || thinking?.supported !== true || thinking.mode !== "budget")
		return { enabled: false }
	const budget = config?.thinkingBudget
	const disabled = config?.enableThinking === false || config?.effort?.trim().toLowerCase() === "none" || budget === 0
	const required = thinking.canDisable === false
	if (disabled && !required) return { enabled: false, fields: { enable_thinking: false } }
	if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) return { enabled: false }
	if (!resolveThinkingBudgetBounds(thinking)) return { enabled: false }
	if (!required && budget === undefined && config?.enableThinking === undefined && thinking.defaultEnabled === undefined)
		return { enabled: false }
	const enabled = required || (!disabled && (config?.enableThinking ?? ((budget ?? 0) > 0 || thinking.defaultEnabled === true)))
	const positiveBudget = enabled && !disabled && budget !== undefined ? clampThinkingBudget(budget, thinking) : undefined
	return {
		enabled,
		fields: { enable_thinking: enabled, ...(positiveBudget !== undefined ? { thinking_budget: positiveBudget } : {}) },
	}
}
