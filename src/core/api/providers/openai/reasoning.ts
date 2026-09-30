import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
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
	if ((effort === "max" || effort === "ultra") && thinking.effortLevels?.includes("xhigh")) effort = "xhigh"
	if (!effort || !thinking.effortLevels?.includes(effort)) return undefined
	switch (effort) {
		case "none":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return effort
		default:
			return undefined
	}
}
