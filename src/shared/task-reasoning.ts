import type { ModelCapabilities, ThinkingConfig } from "@shared/proto/dline/models/metadata"
import type { ApiProfile } from "@shared/proto/dline/profile"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { PROFILE_PROVIDER_KEYS } from "@shared/providers/profile-model-info"
import { resolveThinkingBudgetBounds } from "@shared/providers/thinking-budget"

/** Task-local reasoning policy layered over a Profile's reasoning configuration. */
export interface TaskReasoningOverride {
	readonly kind: "inherit" | "effort" | "budget"
	readonly effort?: string
	readonly budgetTokens?: number
}

export type TaskReasoningOverrideKind = TaskReasoningOverride["kind"]

/** Project declared thinking capabilities without inferring them from a Profile preference or model identity. */
export function resolveTaskThinkingConfig(capabilities: ModelCapabilities | undefined): ThinkingConfig | undefined {
	const thinking = capabilities?.thinking
	if (thinking?.supported !== true || capabilities?.supportsReasoning === false) return undefined
	return {
		...thinking,
		...(thinking.effortLevels !== undefined ? { effortLevels: [...thinking.effortLevels] } : {}),
	}
}

export interface TaskReasoningOverrideFields {
	readonly kind?: string
	readonly effort?: string
	readonly budgetTokens?: number
}

export function taskReasoningOverrideFromFields(
	fields: TaskReasoningOverrideFields,
	legacyEffort?: string,
): TaskReasoningOverride | undefined {
	const kind = fields.kind?.trim()
	if (kind === "effort") {
		return { kind, effort: fields.effort }
	}
	if (kind === "budget") {
		return { kind, budgetTokens: fields.budgetTokens }
	}
	if (kind === "inherit") {
		return { kind }
	}
	if (legacyEffort !== undefined && legacyEffort.trim() !== "") {
		return { kind: "effort", effort: legacyEffort.trim() }
	}
	return undefined
}

export function taskReasoningOverrideToFields(override: TaskReasoningOverride | undefined): TaskReasoningOverrideFields {
	if (!override || override.kind === "inherit") {
		return { kind: undefined, effort: undefined, budgetTokens: undefined }
	}
	if (override.kind === "effort") {
		return { kind: "effort", effort: override.effort, budgetTokens: undefined }
	}
	return { kind: "budget", effort: undefined, budgetTokens: override.budgetTokens }
}

export type TaskReasoningOverrideError =
	| "unsupported_effort"
	| "unsupported_budget"
	| "invalid_effort"
	| "invalid_budget"
	| "negative_budget"
	| "budget_exceeds_max"
	| "budget_below_min"

export type TaskReasoningOverrideValidation =
	| { readonly valid: true; readonly override: TaskReasoningOverride }
	| { readonly valid: false; readonly error: TaskReasoningOverrideError; readonly message: string }

interface ProviderReasoningConfig {
	reasoning?: ReasoningConfig
	readonly [key: string]: unknown
}

/** Read the Profile-owned reasoning configuration for display and inheritance. */
export function resolveProfileReasoningConfig(profile: ApiProfile | undefined): ReasoningConfig | undefined {
	if (!profile) return undefined
	const providerKey = PROFILE_PROVIDER_KEYS[profile.provider]
	if (!providerKey) return undefined
	const providerConfig = readProviderConfig(profile[providerKey])
	return providerConfig?.reasoning ? { ...providerConfig.reasoning } : undefined
}

/** Normalize a Task-local reasoning override into its canonical discriminated shape. */
export function normalizeTaskReasoningOverride(override: TaskReasoningOverride): TaskReasoningOverride {
	switch (override.kind) {
		case "inherit":
			return { kind: "inherit" }
		case "effort":
			return { kind: "effort", effort: override.effort?.trim() }
		case "budget":
			return { kind: "budget", budgetTokens: override.budgetTokens }
	}
}

/** Validate a Task-local reasoning override against the selected model capability. */
export function validateTaskReasoningOverride(
	override: TaskReasoningOverride,
	thinking: ThinkingConfig | undefined,
): TaskReasoningOverrideValidation {
	const normalized = normalizeTaskReasoningOverride(override)
	if (normalized.kind === "inherit") return { valid: true, override: normalized }

	if (normalized.kind === "effort") {
		const effort = normalized.effort
		if (!effort) return invalid("invalid_effort", "Reasoning effort must be a non-empty value.")
		if (
			thinking?.supported !== true ||
			thinking.mode !== "effort" ||
			!thinking.effortLevels?.includes(effort) ||
			(effort === "none" && thinking.canDisable === false)
		) {
			return invalid("unsupported_effort", `Reasoning effort '${effort}' is not supported by the selected model.`)
		}
		return { valid: true, override: { kind: "effort", effort } }
	}

	const budgetTokens = normalized.budgetTokens
	if (budgetTokens === undefined || !Number.isSafeInteger(budgetTokens)) {
		return invalid("invalid_budget", "Reasoning budget must be a safe integer.")
	}
	if (budgetTokens < 0) return invalid("negative_budget", "Reasoning budget cannot be negative.")

	if (thinking?.supported !== true || thinking.mode !== "budget") {
		return invalid("unsupported_budget", "Reasoning budget is not supported by the selected model.")
	}
	if (budgetTokens === 0 && thinking.canDisable === false) {
		return invalid("unsupported_budget", "Thinking cannot be disabled for the selected model.")
	}
	if (budgetTokens === 0) return { valid: true, override: { kind: "budget", budgetTokens } }
	const bounds = resolveThinkingBudgetBounds(thinking)
	if (!bounds) return invalid("unsupported_budget", "The selected model declares invalid reasoning budget bounds.")
	if (budgetTokens < bounds.minimum) {
		return invalid(
			"budget_below_min",
			`Positive reasoning budget must be at least ${bounds.minimum} tokens for the selected model.`,
		)
	}
	if (bounds.maximum !== undefined && budgetTokens > bounds.maximum) {
		return invalid("budget_exceeds_max", `Reasoning budget cannot exceed ${bounds.maximum} tokens for the selected model.`)
	}
	return { valid: true, override: { kind: "budget", budgetTokens } }
}

/** Apply a validated Task-local override to a runtime-only Profile clone. */
export function applyTaskReasoningOverride(profile: ApiProfile, override: TaskReasoningOverride): ApiProfile {
	const normalized = normalizeTaskReasoningOverride(override)
	const providerKey = PROFILE_PROVIDER_KEYS[profile.provider]
	if (!providerKey) {
		if (normalized.kind === "inherit") return { ...profile }
		throw new Error(`Provider '${profile.provider}' does not expose a reasoning configuration.`)
	}

	const providerConfig = readProviderConfig(profile[providerKey])
	if (!providerConfig) {
		if (normalized.kind === "inherit") return { ...profile }
		throw new Error(`Provider '${profile.provider}' has no runtime configuration for a reasoning override.`)
	}

	const inheritedReasoning = providerConfig.reasoning ? { ...providerConfig.reasoning } : undefined
	return {
		...profile,
		[providerKey]: {
			...providerConfig,
			reasoning: applyReasoningConfig(inheritedReasoning, normalized),
		},
	} as ApiProfile
}

function applyReasoningConfig(
	inherited: ReasoningConfig | undefined,
	override: TaskReasoningOverride,
): ReasoningConfig | undefined {
	if (override.kind === "inherit") return inherited
	if (override.kind === "effort") {
		return {
			...inherited,
			enableThinking: override.effort !== "none",
			effort: override.effort,
			thinkingBudget: undefined,
		}
	}
	return {
		...inherited,
		enableThinking: (override.budgetTokens ?? 0) > 0,
		effort: undefined,
		thinkingBudget: override.budgetTokens,
	}
}

function readProviderConfig(value: unknown): ProviderReasoningConfig | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ProviderReasoningConfig) : undefined
}

function invalid(error: TaskReasoningOverrideError, message: string): TaskReasoningOverrideValidation {
	return { valid: false, error, message }
}
