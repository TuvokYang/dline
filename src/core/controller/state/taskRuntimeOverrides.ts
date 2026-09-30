import { getProfileModelInfo } from "@core/api/model-info"
import { readApiProfiles } from "@core/controller/file/getApiProfiles"
import { resolveProfileReference } from "@core/profiles/profile-binding"
import type { ApiConfiguration } from "@shared/api"
import type { Settings as ProtoSettings } from "@shared/proto/dline/state"
import type { SettingsKey } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"
import {
	type TaskServiceTierOverride,
	taskServiceTierOverrideFromFields,
	taskServiceTierOverrideToFields,
	validateTaskServiceTierOverride,
} from "@shared/task-provider-overrides"
import {
	resolveTaskThinkingConfig,
	type TaskReasoningOverride,
	taskReasoningOverrideFromFields,
	taskReasoningOverrideToFields,
	validateTaskReasoningOverride,
} from "@shared/task-reasoning"

export interface TaskSettingMutation {
	readonly key: SettingsKey
	readonly value?: string | number
}

export interface TaskRuntimeOverrideUpdate {
	readonly mutations: readonly TaskSettingMutation[]
	readonly changed: boolean
}

interface ModeFieldNames {
	readonly profileId: "planModeProfileId" | "actModeProfileId"
	readonly profile: "planModeProfile" | "actModeProfile"
	readonly legacyEffort: "planModeReasoningEffort" | "actModeReasoningEffort"
	readonly reasoningKind: "planModeReasoningOverrideKind" | "actModeReasoningOverrideKind"
	readonly reasoningEffort: "planModeReasoningOverrideEffort" | "actModeReasoningOverrideEffort"
	readonly thinkingBudget: "planModeThinkingBudgetTokens" | "actModeThinkingBudgetTokens"
	readonly serviceTierKind: "planModeServiceTierOverrideKind" | "actModeServiceTierOverrideKind"
	readonly serviceTier: "planModeServiceTierOverrideTier" | "actModeServiceTierOverrideTier"
}

const MODE_FIELDS: Record<Mode, ModeFieldNames> = {
	plan: {
		profileId: "planModeProfileId",
		profile: "planModeProfile",
		legacyEffort: "planModeReasoningEffort",
		reasoningKind: "planModeReasoningOverrideKind",
		reasoningEffort: "planModeReasoningOverrideEffort",
		thinkingBudget: "planModeThinkingBudgetTokens",
		serviceTierKind: "planModeServiceTierOverrideKind",
		serviceTier: "planModeServiceTierOverrideTier",
	},
	act: {
		profileId: "actModeProfileId",
		profile: "actModeProfile",
		legacyEffort: "actModeReasoningEffort",
		reasoningKind: "actModeReasoningOverrideKind",
		reasoningEffort: "actModeReasoningOverrideEffort",
		thinkingBudget: "actModeThinkingBudgetTokens",
		serviceTierKind: "actModeServiceTierOverrideKind",
		serviceTier: "actModeServiceTierOverrideTier",
	},
}

/** Parse and validate every mode-scoped Task runtime override before any state mutation. */
export function prepareTaskRuntimeOverrideUpdate(
	settings: ProtoSettings,
	configuration: ApiConfiguration,
): TaskRuntimeOverrideUpdate {
	const mutations: TaskSettingMutation[] = []
	for (const mode of ["plan", "act"] as const) {
		mutations.push(...prepareModeUpdate(settings, configuration, mode))
	}
	return { mutations, changed: mutations.length > 0 }
}

function prepareModeUpdate(settings: ProtoSettings, configuration: ApiConfiguration, mode: Mode): readonly TaskSettingMutation[] {
	const fields = MODE_FIELDS[mode]
	const hasReasoningUpdate =
		settings[fields.reasoningKind] !== undefined ||
		settings[fields.reasoningEffort] !== undefined ||
		settings[fields.thinkingBudget] !== undefined
	const hasServiceTierUpdate = settings[fields.serviceTierKind] !== undefined || settings[fields.serviceTier] !== undefined
	if (!hasReasoningUpdate && !hasServiceTierUpdate) return []

	const profileReference = configuration[fields.profileId] ?? configuration[fields.profile]
	const resolution = resolveProfileReference(readApiProfiles(), profileReference)
	if (resolution.status !== "resolved" || resolution.profile.enabled === false) {
		const displayName = configuration[fields.profile] ?? profileReference ?? mode
		throw new Error(
			resolution.status === "invalid" ? resolution.error : `Profile not valid: "${displayName}" is unavailable.`,
		)
	}
	const profile = resolution.profile

	const mutations: TaskSettingMutation[] = []
	if (hasReasoningUpdate) {
		const override = parseReasoningOverride(settings, fields)
		const modelInfo = getProfileModelInfo(profile)
		const validation = validateTaskReasoningOverride(override, resolveTaskThinkingConfig(modelInfo.capabilities))
		if (!validation.valid) throw new Error(validation.message)
		mutations.push(...reasoningMutations(fields, validation.override))
	}
	if (hasServiceTierUpdate) {
		const override = parseServiceTierOverride(settings, fields)
		const validation = validateTaskServiceTierOverride(override, profile.provider)
		if (!validation.valid) throw new Error(validation.message)
		mutations.push(...serviceTierMutations(fields, validation.override))
	}
	return mutations
}

function parseReasoningOverride(settings: ProtoSettings, fields: ModeFieldNames): TaskReasoningOverride {
	const override = taskReasoningOverrideFromFields({
		kind: settings[fields.reasoningKind],
		effort: settings[fields.reasoningEffort],
		budgetTokens: settings[fields.thinkingBudget],
	})
	if (!override) throw new Error("Task reasoning override is incomplete or invalid.")
	return override
}

function parseServiceTierOverride(settings: ProtoSettings, fields: ModeFieldNames): TaskServiceTierOverride {
	const override = taskServiceTierOverrideFromFields({
		kind: settings[fields.serviceTierKind],
		tier: settings[fields.serviceTier],
	})
	if (!override) throw new Error("Task service tier override is incomplete or invalid.")
	return override
}

function reasoningMutations(fields: ModeFieldNames, override: TaskReasoningOverride): readonly TaskSettingMutation[] {
	const values = taskReasoningOverrideToFields(override)
	return [
		{ key: fields.reasoningKind, value: values.kind },
		{ key: fields.reasoningEffort, value: values.effort },
		{ key: fields.thinkingBudget, value: values.budgetTokens },
		{ key: fields.legacyEffort, value: undefined },
	]
}

function serviceTierMutations(fields: ModeFieldNames, override: TaskServiceTierOverride): readonly TaskSettingMutation[] {
	const values = taskServiceTierOverrideToFields(override)
	return [
		{ key: fields.serviceTierKind, value: values.kind },
		{ key: fields.serviceTier, value: values.tier },
	]
}
