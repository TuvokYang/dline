import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { clampThinkingBudget, resolveThinkingBudgetBounds } from "@shared/providers/thinking-budget"
import type OpenAI from "openai"

type OpenAIReasoningEffort = NonNullable<OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"]>

/** Encode OpenAI-compatible effort only inside a declared effort-mode capability. */
export function resolveOpenAIReasoningEffort(
	capabilities: ModelCapabilities | undefined,
	reasoning: ReasoningConfig | undefined,
): OpenAIReasoningEffort | undefined {
	const thinking = capabilities?.thinking
	if (capabilities?.supportsReasoning === false || thinking?.supported !== true || thinking.mode !== "effort") return undefined
	const disabled = reasoning?.enableThinking === false || reasoning?.effort?.trim().toLowerCase() === "none"
	if (disabled && thinking.canDisable === false) return undefined
	if (!reasoning?.effort && reasoning?.enableThinking === undefined && thinking.defaultEnabled === undefined) return undefined
	const enabled =
		thinking.canDisable === false ||
		(!disabled && (reasoning?.enableThinking ?? Boolean(reasoning?.effort || thinking.defaultEnabled)))
	let effort = disabled || !enabled ? "none" : reasoning?.effort?.trim().toLowerCase() || thinking.defaultEffort
	if (effort === "ultra" && thinking.effortLevels?.includes("max")) effort = "max"
	else if (
		(effort === "max" || effort === "ultra") &&
		!thinking.effortLevels?.includes(effort) &&
		thinking.effortLevels?.includes("xhigh")
	)
		effort = "xhigh"
	if (!effort || !thinking.effortLevels?.includes(effort)) return undefined
	switch (effort) {
		case "none":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return effort
		default:
			return undefined
	}
}

interface OpenAIReasoning {
	enabled: boolean
	mode?: "effort" | "budget"
	effort?: OpenAIReasoningEffort
	budget?: number
}

/** Native Chat/Responses share activation policy but encode different controls. */
export function resolveOpenAIReasoning(
	capabilities: ModelCapabilities | undefined,
	config: ReasoningConfig | undefined,
): OpenAIReasoning {
	const thinking = capabilities?.thinking
	if (capabilities?.supportsReasoning === false || thinking?.supported !== true) return { enabled: false }
	const mode = thinking.mode
	if (mode !== "effort" && mode !== "budget") return { enabled: false }
	const requestedEffort = config?.effort?.trim().toLowerCase()
	const budget = mode === "budget" ? config?.thinkingBudget : undefined
	const disabled = config?.enableThinking === false || requestedEffort === "none" || budget === 0
	const required = thinking.canDisable === false
	if (mode === "effort") {
		const effort = resolveOpenAIReasoningEffort(capabilities, config)
		const legalSelection = requestedEffort !== undefined && thinking.effortLevels?.includes(requestedEffort) === true
		const enabled =
			required ||
			(!disabled &&
				(config?.enableThinking ??
					(legalSelection || (effort !== undefined && effort !== "none") || thinking.defaultEnabled === true)))
		return { enabled, mode, ...(effort !== undefined ? { effort } : {}) }
	}
	if (disabled && !required) return { enabled: false, mode }
	if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) return { enabled: false }
	if (!resolveThinkingBudgetBounds(thinking)) return { enabled: false }
	const enabled = required || (!disabled && (config?.enableThinking ?? ((budget ?? 0) > 0 || thinking.defaultEnabled === true)))
	if (!enabled) return { enabled: false }
	return {
		enabled: true,
		mode,
		...(!disabled && budget !== undefined ? { budget: clampThinkingBudget(budget, thinking) } : {}),
	}
}

/** OpenAI-compatible Chat's budget extension must never leak onto the Responses API. */
export function encodeOpenAIChatReasoning(
	capabilities: ModelCapabilities | undefined,
	config: ReasoningConfig | undefined,
): { enable_thinking?: boolean; thinking_budget?: number; reasoning_effort?: OpenAIReasoningEffort | "ultra" } {
	const resolved = resolveOpenAIReasoning(capabilities, config)
	if (resolved.mode === "budget")
		return {
			enable_thinking: resolved.enabled,
			...(resolved.budget !== undefined ? { thinking_budget: resolved.budget } : {}),
		}
	if (resolved.mode !== "effort") return {}
	// A compatible endpoint may explicitly declare the legacy wire value.
	const raw = config?.effort?.trim().toLowerCase() || capabilities?.thinking?.defaultEffort
	if (resolved.enabled && raw === "ultra" && capabilities?.thinking?.effortLevels?.includes("ultra"))
		return { reasoning_effort: "ultra" }
	return resolved.effort !== undefined ? { reasoning_effort: resolved.effort } : {}
}

export function encodeOpenAIResponsesReasoning(
	capabilities: ModelCapabilities | undefined,
	config: ReasoningConfig | undefined,
): NonNullable<OpenAI.Responses.ResponseCreateParams["reasoning"]> | undefined {
	const resolved = resolveOpenAIReasoning(capabilities, config)
	if (resolved.mode !== "effort") return undefined
	if (!resolved.enabled) return resolved.effort === "none" ? { effort: "none" } : undefined
	return { ...(resolved.effort && resolved.effort !== "none" ? { effort: resolved.effort } : {}), summary: "auto" }
}
