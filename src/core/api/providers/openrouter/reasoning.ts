import type { ModelCapabilities, ThinkingConfig } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { clampThinkingBudget, resolveThinkingBudgetBounds } from "@shared/providers/thinking-budget"
import { resolveAnthropicReasoning } from "../anthropic/reasoning"

export interface OpenRouterReasoning {
	enabled: boolean
	omitSampling: boolean
	reasoning?: Record<string, unknown>
	verbosity?: string
}

function encodeEffort(preference: string | undefined, thinking: ThinkingConfig): string | undefined {
	let effort = preference?.trim().toLowerCase()
	if (effort === "ultra" && thinking.effortLevels?.includes("max")) effort = "max"
	return effort &&
		["minimal", "low", "medium", "high", "xhigh", "max"].includes(effort) &&
		thinking.effortLevels?.includes(effort)
		? effort
		: undefined
}

/** OpenRouter translates Anthropic verbosity to output_config.effort; a route never grants support. */
export function resolveOpenRouterReasoning(
	modelId: string,
	capabilities: ModelCapabilities | undefined,
	config: ReasoningConfig | undefined,
): OpenRouterReasoning {
	const thinking = capabilities?.thinking
	const unsupported = { enabled: false, omitSampling: false }
	if (capabilities?.supportsReasoning === false || thinking?.supported !== true) return unsupported
	if (thinking.mode !== "budget" && thinking.mode !== "effort") return unsupported
	if (modelId.startsWith("anthropic/")) {
		const result = resolveAnthropicReasoning(capabilities, config)
		return {
			enabled: result.enabled,
			omitSampling: result.adaptive || result.enabled,
			reasoning:
				result.thinking?.type === "enabled"
					? { max_tokens: result.thinking.budget_tokens }
					: result.thinking
						? { enabled: result.enabled }
						: undefined,
			verbosity: result.outputConfig?.effort,
		}
	}
	const disabled =
		config?.enableThinking === false ||
		config?.effort?.trim().toLowerCase() === "none" ||
		(thinking.mode === "budget" && config?.thinkingBudget === 0)
	if (disabled && thinking.canDisable !== false) return { ...unsupported, reasoning: { enabled: false } }
	const hasPreference =
		thinking.mode === "budget"
			? clampThinkingBudget(config?.thinkingBudget ?? 0, thinking) !== undefined
			: encodeEffort(config?.effort, thinking) !== undefined
	const enabled =
		thinking.canDisable === false ||
		(!disabled && (config?.enableThinking ?? (hasPreference || thinking.defaultEnabled === true)))
	if (!enabled) return unsupported
	if (thinking.mode === "budget") {
		if (!resolveThinkingBudgetBounds(thinking)) return unsupported
		const budget = disabled ? undefined : config?.thinkingBudget
		if (budget === undefined) return { enabled: true, omitSampling: true, reasoning: { enabled: true } }
		const budgetTokens = clampThinkingBudget(budget, thinking)
		if (budgetTokens === undefined) return unsupported
		return {
			enabled: true,
			omitSampling: true,
			reasoning: { max_tokens: budgetTokens },
		}
	}
	const effort = disabled ? undefined : encodeEffort(config?.effort?.trim() || thinking.defaultEffort, thinking)
	return { enabled: true, omitSampling: false, reasoning: effort ? { effort } : { enabled: true } }
}
