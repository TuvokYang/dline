import type { ModelCapabilities, ThinkingConfig } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"

type DeepSeekEffort = "low" | "high" | "max"

export interface DeepSeekReasoning {
	supported: boolean
	enabled: boolean
	effort?: DeepSeekEffort
}

function declaredEffort(value: string | undefined, thinking: ThinkingConfig): DeepSeekEffort | undefined {
	if (!value || !thinking.effortLevels?.includes(value)) return undefined
	return value === "low" || value === "high" || value === "max" ? value : undefined
}

/** Encode DeepSeek aliases and defaults only inside a declared effort-mode capability. */
export function resolveDeepSeekReasoning(
	capabilities: ModelCapabilities | undefined,
	reasoning: ReasoningConfig | undefined,
): DeepSeekReasoning {
	const thinking = capabilities?.thinking
	if (capabilities?.supportsReasoning === false || thinking?.supported !== true || thinking.mode !== "effort") {
		return { supported: false, enabled: false }
	}
	let preference = reasoning?.effort?.trim().toLowerCase()
	const disabled = reasoning?.enableThinking === false || preference === "none"
	// An explicit empty legacy config leaves thinking off; an absent config follows the declaration.
	const requested = reasoning?.enableThinking ?? (reasoning ? Boolean(preference) : thinking.defaultEnabled === true)
	const enabled = thinking.canDisable === false || (!disabled && requested)
	if (!enabled) return { supported: true, enabled: false }

	if (preference === "xhigh" || preference === "ultra") preference = "max"
	const effort = declaredEffort(preference, thinking) ?? declaredEffort(thinking.defaultEffort, thinking)
	return { supported: true, enabled: true, effort }
}
