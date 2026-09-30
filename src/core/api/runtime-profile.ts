import type { ApiConfiguration } from "@shared/api"
import type { ApiProfile } from "@shared/proto/dline/profile"
import type { Mode } from "@shared/storage/types"
import { applyTaskServiceTierOverride, validateTaskServiceTierOverride } from "@shared/task-provider-overrides"
import { applyTaskReasoningOverride, resolveTaskThinkingConfig, validateTaskReasoningOverride } from "@shared/task-reasoning"
import { getProfileModelInfo } from "./model-info"

/**
 * Apply mode-scoped Task overrides to a runtime-only Profile clone.
 *
 * The Catalog Profile remains unchanged. Overrides are revalidated at the
 * request-handler boundary so stale or externally edited task settings cannot
 * bypass current provider and model capabilities.
 */
export function applyTaskRuntimeOverrides(profile: ApiProfile, configuration: ApiConfiguration, mode: Mode): ApiProfile {
	const reasoningOverride = mode === "plan" ? configuration.planModeReasoningOverride : configuration.actModeReasoningOverride
	const serviceTierOverride =
		mode === "plan" ? configuration.planModeServiceTierOverride : configuration.actModeServiceTierOverride

	let runtimeProfile = { ...profile }
	if (reasoningOverride) {
		const modelInfo = getProfileModelInfo(profile)
		const validation = validateTaskReasoningOverride(reasoningOverride, resolveTaskThinkingConfig(modelInfo.capabilities))
		if (!validation.valid) throw new Error(validation.message)
		runtimeProfile = applyTaskReasoningOverride(runtimeProfile, validation.override)
	}

	if (serviceTierOverride) {
		const validation = validateTaskServiceTierOverride(serviceTierOverride, profile.provider)
		if (!validation.valid) throw new Error(validation.message)
		runtimeProfile = applyTaskServiceTierOverride(runtimeProfile, validation.override)
	}

	return runtimeProfile
}
