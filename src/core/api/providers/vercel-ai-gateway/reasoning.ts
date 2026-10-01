import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { clampThinkingBudget } from "@shared/providers/thinking-budget"
import { resolveAnthropicReasoning } from "../anthropic/reasoning"

export interface VercelReasoning {
	enabled: boolean
	omitSampling: boolean
	reasoning?: Record<string, unknown>
}

/** Vercel's Chat Completions gateway maps reasoning.effort to the declared upstream mode. */
export function resolveVercelReasoning(
	modelId: string,
	capabilities: ModelCapabilities | undefined,
	config: ReasoningConfig | undefined,
): VercelReasoning {
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
						? { enabled: result.enabled, ...(result.outputConfig ? { effort: result.outputConfig.effort } : {}) }
						: undefined,
		}
	}
	const disabled =
		config?.enableThinking === false ||
		config?.effort?.trim().toLowerCase() === "none" ||
		(thinking.mode === "budget" && config?.thinkingBudget === 0)
	if (disabled && thinking.canDisable !== false) return { ...unsupported, reasoning: { enabled: false } }
	const enabled =
		thinking.canDisable === false ||
		(!disabled &&
			(config?.enableThinking ?? Boolean(config?.effort || (config?.thinkingBudget ?? 0) > 0 || thinking.defaultEnabled)))
	if (!enabled) return unsupported
	if (thinking.mode === "budget") {
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
	let effort = disabled ? undefined : config?.effort?.trim().toLowerCase() || thinking.defaultEffort
	if (effort === "ultra" && thinking.effortLevels?.includes("max")) effort = "max"
	const legal =
		effort && ["minimal", "low", "medium", "high", "xhigh", "max"].includes(effort) && thinking.effortLevels?.includes(effort)
	return { enabled: true, omitSampling: false, reasoning: legal ? { effort } : { enabled: true } }
}
