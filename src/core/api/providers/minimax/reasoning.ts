import type { OutputConfig } from "@anthropic-ai/sdk/resources/messages"
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"

interface MiniMaxReasoning {
	enabled: boolean
	thinking?: { type: "adaptive" | "disabled" }
	outputConfig?: OutputConfig
}

/** MiniMax uses adaptive thinking; budget_tokens is not a supported control. */
export function resolveMiniMaxReasoning(
	capabilities: ModelCapabilities | undefined,
	reasoning: ReasoningConfig | undefined,
): MiniMaxReasoning {
	const thinking = capabilities?.thinking
	if (capabilities?.supportsReasoning === false || thinking?.supported !== true || thinking.mode !== "effort") {
		return { enabled: false }
	}
	const disabled = reasoning?.enableThinking === false || reasoning?.effort?.trim().toLowerCase() === "none"
	if (disabled && thinking.canDisable !== false) return { enabled: false, thinking: { type: "disabled" } }
	const explicitEffort = disabled ? undefined : resolveEffort(reasoning?.effort, thinking.effortLevels)
	const enabled =
		thinking.canDisable === false ||
		(!disabled && (reasoning?.enableThinking ?? (explicitEffort !== undefined || thinking.defaultEnabled === true)))
	if (!enabled) return { enabled: false }
	const effort =
		explicitEffort ?? (reasoning?.effort ? undefined : resolveEffort(thinking.defaultEffort, thinking.effortLevels))
	return { enabled: true, thinking: { type: "adaptive" }, ...(effort ? { outputConfig: { effort } } : {}) }
}

function resolveEffort(effort: string | undefined, allowed: readonly string[] | undefined): OutputConfig["effort"] | undefined {
	const value = effort?.trim().toLowerCase()
	const candidate = value === "ultra" && allowed?.includes("max") ? "max" : value
	if (!candidate || !allowed?.includes(candidate)) return undefined
	switch (candidate) {
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return candidate
		default:
			return undefined
	}
}
