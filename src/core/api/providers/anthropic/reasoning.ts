import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages/messages"
import type { ModelCapabilities, ThinkingConfig } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { clampThinkingBudget } from "@shared/providers/thinking-budget"

type AdaptiveEffort = NonNullable<NonNullable<MessageCreateParamsStreaming["output_config"]>["effort"]>
type ThinkingDisplay = "summarized" | "omitted"

/** Anthropic wire fields and request state derived from the effective model declaration. */
export interface AnthropicReasoning {
	enabled: boolean
	adaptive: boolean
	thinking?: MessageCreateParamsStreaming["thinking"]
	outputConfig?: { effort: AdaptiveEffort }
}

/** Narrow a persisted preference to the Messages API display protocol. */
export function resolveAnthropicThinkingDisplay(display?: string): ThinkingDisplay | undefined {
	const value = display?.trim().toLowerCase()
	return value === "summarized" || value === "omitted" ? value : undefined
}

/** Encode legacy aliases only after the model declares effort-mode thinking and its legal levels. */
function resolveAdaptiveEffort(preference: string | undefined, thinking: ThinkingConfig): AdaptiveEffort | undefined {
	let value = preference?.trim().toLowerCase()
	if (value === "minimal") value = "low"
	if (value === "ultra") value = "max"
	const levels = thinking.effortLevels ?? []
	if (value === "xhigh" && !levels.includes("xhigh") && levels.includes("max")) value = "max"
	if (!value || !levels.includes(value)) return undefined
	switch (value) {
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return value
		default:
			return undefined
	}
}

/**
 * Convert declared thinking modes to Messages API fields. No model identity or
 * catalog fallback is accepted here; missing/negative declarations stay unsupported.
 * A stale disable preference cannot turn off required thinking, and carries no effort.
 */
export function resolveAnthropicReasoning(
	capabilities: ModelCapabilities | undefined,
	reasoning: ReasoningConfig | undefined,
): AnthropicReasoning {
	const thinking = capabilities?.thinking
	if (capabilities?.supportsReasoning === false || thinking?.supported !== true) {
		return { enabled: false, adaptive: false }
	}
	const adaptive = thinking.mode === "effort"
	if (!adaptive && thinking.mode !== "budget") return { enabled: false, adaptive: false }

	const budget = reasoning?.thinkingBudget ?? 0
	const disableRequested = reasoning?.enableThinking === false || reasoning?.effort?.trim().toLowerCase() === "none"
	const hasPreference = adaptive
		? resolveAdaptiveEffort(reasoning?.effort, thinking) !== undefined
		: clampThinkingBudget(budget, thinking) !== undefined
	const requested = reasoning?.enableThinking ?? hasPreference
	const enabled = thinking.canDisable === false || (!disableRequested && (requested || thinking.defaultEnabled === true))
	if (!enabled) {
		return {
			enabled: false,
			adaptive,
			thinking: adaptive && disableRequested ? { type: "disabled" } : undefined,
		}
	}

	const display = resolveAnthropicThinkingDisplay(reasoning?.display)
	const displayField = display ? { display } : {}
	if (adaptive) {
		const preference = disableRequested ? undefined : reasoning?.effort || thinking.defaultEffort
		const effort = resolveAdaptiveEffort(preference, thinking)
		return {
			enabled: true,
			adaptive: true,
			thinking: { type: "adaptive", ...displayField },
			outputConfig: effort ? { effort } : undefined,
		}
	}

	const budgetTokens = clampThinkingBudget(budget, thinking)
	if (budgetTokens === undefined) return { enabled: false, adaptive: false }
	return {
		enabled: true,
		adaptive: false,
		thinking: { type: "enabled", budget_tokens: budgetTokens, ...displayField },
	}
}
