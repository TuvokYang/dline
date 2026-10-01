import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { encodeOpenAIResponsesReasoning, resolveOpenAIReasoning } from "../openai/reasoning"

/** Codex may declare ultra independently of the API-key endpoint's legal efforts. */
export function resolveCodexReasoning(capabilities: ModelCapabilities | undefined, config: ReasoningConfig | undefined) {
	const resolved = resolveOpenAIReasoning(capabilities, config)
	const enabled = resolved.mode === "effort" && resolved.enabled
	const candidate = config?.effort?.trim().toLowerCase() || capabilities?.thinking?.defaultEffort
	const declaredUltra = enabled && candidate === "ultra" && capabilities?.thinking?.effortLevels?.includes("ultra")
	return {
		enabled,
		reasoning: declaredUltra ? { effort: "ultra", summary: "auto" } : encodeOpenAIResponsesReasoning(capabilities, config),
	}
}
