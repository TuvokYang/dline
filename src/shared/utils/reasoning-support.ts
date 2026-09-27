import { normalizeOpenaiReasoningEffort, type OpenaiReasoningEffort } from "../storage/types"

export const ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS = ["none", "low", "medium", "high", "xhigh", "max"] as const
export const ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH = ["none", "low", "medium", "high", "max"] as const
export const ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const

export type ClaudeAdaptiveThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max"

export interface ClaudeOpusAdaptiveThinkingSettings {
	enabled: boolean
	effort?: ClaudeAdaptiveThinkingEffort
}

/**
 * How Anthropic returns thinking content when the request opts in.
 *
 * `summarized` returns thinking normally; `omitted` redacts the content but still
 * returns a signature for multi-turn continuity. A profile may also leave this
 * unset, which omits the field and lets the API default apply.
 */
export const ANTHROPIC_THINKING_DISPLAY_OPTIONS = ["summarized", "omitted"] as const

export type ClaudeThinkingDisplay = (typeof ANTHROPIC_THINKING_DISPLAY_OPTIONS)[number]

/** Narrow a persisted display preference to a value the Messages API accepts. */
export function resolveClaudeThinkingDisplay(display?: string): ClaudeThinkingDisplay | undefined {
	const normalized = display?.trim().toLowerCase()
	return ANTHROPIC_THINKING_DISPLAY_OPTIONS.find((option) => option === normalized)
}

export const DEEPSEEK_REASONING_EFFORT_OPTIONS = ["low", "high", "max"] as const

export type DeepSeekReasoningEffort = (typeof DEEPSEEK_REASONING_EFFORT_OPTIONS)[number]

/** Identify DeepSeek model IDs across native and OpenAI-compatible providers. */
export function isDeepSeekReasoningModel(modelId?: string): boolean {
	return modelId?.toLowerCase().includes("deepseek") === true
}

export interface DeepSeekAdaptiveThinkingSettings {
	enabled: boolean
	effort?: DeepSeekReasoningEffort
}

/**
 * Report whether adaptive thinking starts on for a model.
 *
 * Deliberately narrower than {@link isClaudeAdaptiveThinkingModel}: the 4.6
 * generation supports adaptive thinking but leaves it off until the user asks
 * for it, while the 5 series starts with it on. The two answers differ, so they
 * stay separate predicates rather than one shared list.
 */
export function isClaudeAdaptiveThinkingEnabledByDefault(modelId?: string): boolean {
	const id = modelId?.toLowerCase()
	return (
		id?.includes("claude-fable-5") === true ||
		id?.includes("claude-opus-5") === true ||
		id?.includes("claude-sonnet-5") === true
	)
}

export function canDisableClaudeAdaptiveThinking(modelId?: string): boolean {
	return modelId?.toLowerCase().includes("claude-fable-5") !== true
}

/** Model capabilities this resolution reads; a subset of `ModelCapabilities`. */
interface ForcedToolUseCapabilities {
	supportsForcedToolUse?: boolean
	thinking?: { mode?: string }
}

/**
 * Report whether a model accepts a forced tool choice such as `tool_choice: any`.
 *
 * Models that reject it answer `tool_choice: type "tool" and "any" are not
 * supported for this model` and fail the whole generation, so the decision has
 * to be right before the request is sent rather than recovered afterwards.
 *
 * The model's own declaration wins. Only when one is missing does this infer,
 * and only for Claude: adaptive thinking there stays on, and thinking cannot be
 * combined with forced tool use. That inference is deliberately not applied to
 * other vendors, whose effort-mode thinking carries no such restriction, so an
 * undeclared non-Claude model keeps the forced choice it has always sent.
 */
export function resolveForcedToolUseSupport(modelId?: string, capabilities?: ForcedToolUseCapabilities): boolean {
	if (capabilities?.supportsForcedToolUse !== undefined) {
		return capabilities.supportsForcedToolUse
	}
	if (!isClaudeModelId(modelId)) {
		return true
	}
	if (capabilities?.thinking?.mode !== undefined) {
		return capabilities.thinking.mode !== "effort"
	}
	// The request path already decides which models take an effort level, so
	// reusing that answer keeps one model from being forceable here and
	// adaptive there. A second list drifts apart from it silently.
	return !isClaudeAdaptiveThinkingModel(modelId)
}

/** Identify a Claude model, whose forced-tool-use rules this module encodes. */
function isClaudeModelId(modelId?: string): boolean {
	return modelId?.toLowerCase().includes("claude") === true
}

/** Claude releases from 4.6 onward, whose generation keeps adaptive thinking on. */
const CLAUDE_ADAPTIVE_GENERATION_VERSIONS = ["4-6", "4.6", "4-7", "4.7", "4-8", "4.8"] as const

/**
 * Identify a Claude model whose generation keeps adaptive thinking on.
 *
 * This covers the whole generation rather than one family: Sonnet 4.6 behaves
 * like Opus 4.6 here, and a check that named only Opus would disagree with the
 * catalogs that declare both adaptive. Model IDs are matched loosely because the
 * same model reaches us renamed by Vertex, Bedrock, and OpenRouter.
 */
export function isClaudeAdaptiveThinkingModel(modelId?: string): boolean {
	if (!modelId) {
		return false
	}

	const id = modelId.toLowerCase()
	if (id.includes("claude-fable-5") || id.includes("claude-opus-5") || id.includes("claude-sonnet-5")) {
		return true
	}
	return CLAUDE_ADAPTIVE_GENERATION_VERSIONS.some(
		(version) =>
			id.includes(`claude-opus-${version}`) ||
			id.includes(`claude-sonnet-${version}`) ||
			id.includes(`claude-${version}-opus`) ||
			id.includes(`claude-${version}-sonnet`),
	)
}

/**
 * Historical name for {@link isClaudeAdaptiveThinkingModel}.
 *
 * Kept because several provider request paths import it; the rule was never
 * Opus-only, so the name is the part that was wrong.
 */
export const isClaudeOpusAdaptiveThinkingModel = isClaudeAdaptiveThinkingModel

export function resolveClaudeOpusAdaptiveThinking(
	reasoningEffort?: string,
	legacyThinkingBudgetTokens?: number,
): ClaudeOpusAdaptiveThinkingSettings {
	if (reasoningEffort) {
		const effort = normalizeOpenaiReasoningEffort(reasoningEffort)
		if (effort === "none") {
			return { enabled: false }
		}
		if (effort === "minimal") {
			return { enabled: true, effort: "low" }
		}
		if (effort === "ultra") {
			return { enabled: true, effort: "max" }
		}
		return { enabled: true, effort }
	}

	return legacyThinkingBudgetTokens && legacyThinkingBudgetTokens > 0 ? { enabled: true, effort: "high" } : { enabled: false }
}

/**
 * Resolves adaptive thinking settings for DeepSeek V4 models.
 *
 * DeepSeek V4 supports thinking mode: the model outputs a chain-of-thought
 * (reasoning_content) before the final answer to improve accuracy.
 *
 * Behavior:
 * 1. Default thinking is enabled.
 * 2. Default effort is "high" for standard requests; for complex agent-style
 *    requests (e.g., Claude Code, OpenCode), effort is automatically set to "max".
 * 3. The native "low", "high", and "max" values are preserved; legacy higher
 *    aliases continue to map to "max", while unknown values fall back to "high".
 */
export function resolveDeepSeekAdaptiveThinking(reasoningEffort?: string): DeepSeekAdaptiveThinkingSettings {
	if (!reasoningEffort) {
		return { enabled: true, effort: "high" }
	}

	const effort = reasoningEffort.toLowerCase() as OpenaiReasoningEffort
	if (effort === "none") {
		return { enabled: false }
	}
	if (effort === "max" || effort === "xhigh" || effort === "ultra") {
		return { enabled: true, effort: "max" }
	}
	if (effort === "low" || effort === "high") {
		return { enabled: true, effort }
	}
	return { enabled: true, effort: "high" }
}

export function supportsReasoningEffortForModel(modelId?: string): boolean {
	if (!modelId) {
		return false
	}

	const id = modelId.toLowerCase()
	return (
		id.includes("gemini") ||
		id.includes("gpt") ||
		id.startsWith("openai/o") ||
		id.includes("/o") ||
		id.startsWith("o") ||
		id.includes("grok")
	)
}
