import type { ThinkingConfig } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"

export interface DeepSeekThinkingPreference {
	supported: boolean
	enabled: boolean
	effortLevels: string[]
	profileEffort: string
	defaultEffort: string
	selectedEffort?: string
}

/** Resolve the DeepSeek UI preference with the same absent-versus-empty semantics as its request encoder. */
export function resolveDeepSeekThinkingPreference(
	reasoning: ReasoningConfig | undefined,
	thinking: ThinkingConfig | undefined,
	supportsReasoning: boolean | undefined = true,
): DeepSeekThinkingPreference {
	const supported = supportsReasoning !== false && thinking?.supported === true && thinking.mode === "effort"
	if (!supported) {
		return { supported: false, enabled: false, effortLevels: [], profileEffort: "", defaultEffort: "" }
	}

	const effortLevels = (thinking.effortLevels ?? []).filter((effort) => thinking.canDisable !== false || effort !== "none")
	const requestedEffort = reasoning?.effort?.trim().toLowerCase() ?? ""
	const profileEffort =
		(requestedEffort === "xhigh" || requestedEffort === "ultra") && effortLevels.includes("max") ? "max" : requestedEffort
	const explicitEffort =
		(profileEffort === "low" || profileEffort === "high" || profileEffort === "max") && effortLevels.includes(profileEffort)
			? profileEffort
			: undefined
	const defaultEffort = thinking.defaultEffort && effortLevels.includes(thinking.defaultEffort) ? thinking.defaultEffort : ""
	const disabled = reasoning?.enableThinking === false || requestedEffort === "none"
	const enabled =
		thinking.canDisable === false ||
		(!disabled && (reasoning ? (reasoning.enableThinking ?? explicitEffort !== undefined) : thinking.defaultEnabled === true))

	return {
		supported: true,
		enabled,
		effortLevels,
		profileEffort,
		defaultEffort,
		selectedEffort: enabled ? (explicitEffort ?? defaultEffort) || undefined : undefined,
	}
}

/** Format the collapsed DeepSeek card from its Provider-owned preference policy. */
export function formatDeepSeekThinkingSummary(
	reasoning: ReasoningConfig | undefined,
	thinking: ThinkingConfig | undefined,
): string | undefined {
	const preference = resolveDeepSeekThinkingPreference(reasoning, thinking)
	if (!preference.supported) return undefined
	if (!preference.enabled) return "Thinking: Off"
	return preference.selectedEffort
		? `Thinking: ${preference.selectedEffort.replace(/^./, (character) => character.toUpperCase())}`
		: "Thinking: On"
}
