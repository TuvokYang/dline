import { type ThinkingConfig as GeminiThinkingConfig, ThinkingLevel } from "@google/genai"
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"

/** Encode declared Gemini thinking; omission retains the server's dynamic default. */
export function resolveGeminiThinking(
	capabilities: ModelCapabilities | undefined,
	reasoning: ReasoningConfig | undefined,
): GeminiThinkingConfig | undefined {
	const thinking = capabilities?.thinking
	if (thinking?.supported !== true || capabilities?.supportsReasoning === false) return undefined
	if (thinking.mode !== "budget" && thinking.mode !== "effort") return undefined

	const required = thinking.canDisable === false
	const effort = reasoning?.effort?.trim().toLowerCase()
	const budget = thinking.mode === "budget" ? reasoning?.thinkingBudget : undefined
	const disabled = reasoning?.enableThinking === false || effort === "none" || budget === 0
	if (disabled && !required) return { thinkingBudget: 0, includeThoughts: false }

	if (thinking.mode === "budget") {
		if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < -1)) return undefined
		const maximum = thinking.maxBudget
		if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum <= 0)) return undefined
		const enabled =
			required || (!disabled && (reasoning?.enableThinking ?? (budget !== undefined || thinking.defaultEnabled === true)))
		if (!enabled) return undefined
		if (disabled || budget === undefined) return { includeThoughts: true }
		// -1 is Gemini's explicit dynamic-budget wire value, not a manufactured default.
		return {
			thinkingBudget: budget === -1 || maximum === undefined ? budget : Math.min(budget, maximum),
			includeThoughts: true,
		}
	}

	const explicitLevel = disabled ? undefined : resolveLevel(effort, thinking.effortLevels)
	const enabled =
		required ||
		(!disabled && (reasoning?.enableThinking ?? (explicitLevel !== undefined || thinking.defaultEnabled === true)))
	if (!enabled) return undefined
	const level = explicitLevel ?? (effort ? undefined : resolveLevel(thinking.defaultEffort, thinking.effortLevels))
	return level === undefined ? { includeThoughts: true } : { thinkingLevel: level, includeThoughts: true }
}

function resolveLevel(effort: string | undefined, allowed: readonly string[] | undefined): ThinkingLevel | undefined {
	const value = effort === "xhigh" && allowed?.includes("high") ? "high" : effort
	if (!value || !allowed?.includes(value)) return undefined
	switch (value) {
		case "minimal":
			return ThinkingLevel.MINIMAL
		case "low":
			return ThinkingLevel.LOW
		case "medium":
			return ThinkingLevel.MEDIUM
		case "high":
			return ThinkingLevel.HIGH
		default:
			return undefined
	}
}
