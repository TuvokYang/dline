import { useApiProfiles } from "@components/settings/providers/useApiProfiles"
import { useProviderModels } from "@components/settings/providers/useProviderModels"
import { updateTaskSettings } from "@components/settings/utils/settingsHandlers"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@components/ui/tooltip"
import { useExtensionState } from "@context/ExtensionStateContext"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { resolveThinkingBudgetBounds } from "@shared/providers/thinking-budget"
import type { OpenAiServiceTier } from "@shared/storage/types"
import { profileServiceTierEnabled, resolveProfileServiceTier } from "@shared/task-provider-overrides"
import { resolveProfileReasoningConfig, resolveTaskThinkingConfig, validateTaskReasoningOverride } from "@shared/task-reasoning"
import { useEffect, useMemo, useState } from "react"
import { TaskServiceTierControl } from "./TaskServiceTierControl"

/** Task-local reasoning and OpenAI service-tier controls for the chat input toolbar. */
export function TaskRuntimeControls() {
	const { apiConfiguration, currentTaskItem, mode, taskViewState } = useExtensionState()
	const { profiles } = useApiProfiles()
	const [error, setError] = useState<string>()

	const taskId = taskViewState?.taskId
	const profileId = mode === "plan" ? apiConfiguration?.planModeProfileId : apiConfiguration?.actModeProfileId
	const profileName = mode === "plan" ? apiConfiguration?.planModeProfile : apiConfiguration?.actModeProfile
	const profile = useMemo(
		() =>
			(profileId ? profiles.find((candidate) => candidate.id === profileId) : undefined) ??
			(profileName ? profiles.find((candidate) => candidate.name === profileName) : undefined),
		[profileId, profileName, profiles],
	)
	const { models: providerModels, defaultModelId: providerDefaultModelId } = useProviderModels(profile?.provider ?? "")
	const effectiveModelInfo = profile
		? resolveProfileModelInfo(profile, { models: providerModels, defaultModelId: providerDefaultModelId })
		: undefined
	const profileReasoning = resolveProfileReasoningConfig(profile)
	const thinking = resolveTaskThinkingConfig(effectiveModelInfo?.capabilities)
	const effortLevels = (thinking?.effortLevels ?? []).filter((effort) => thinking?.canDisable !== false || effort !== "none")
	const budgetBounds = thinking ? resolveThinkingBudgetBounds(thinking) : undefined
	const maxBudget = budgetBounds?.maximum
	const minBudget = thinking?.canDisable === false ? budgetBounds?.minimum : 0
	const supportsEffort = thinking?.mode === "effort" && effortLevels.length > 0
	const supportsBudget = thinking?.mode === "budget" && budgetBounds !== undefined
	const supportsServiceTier = profileServiceTierEnabled(profile)

	const reasoningOverride =
		mode === "plan" ? apiConfiguration?.planModeReasoningOverride : apiConfiguration?.actModeReasoningOverride
	const serviceTierOverride =
		mode === "plan" ? apiConfiguration?.planModeServiceTierOverride : apiConfiguration?.actModeServiceTierOverride
	const profileThinkingValue =
		supportsBudget && (profileReasoning?.thinkingBudget ?? 0) > 0
			? "budget"
			: supportsEffort && profileReasoning?.effort && effortLevels.includes(profileReasoning.effort)
				? `effort:${profileReasoning.effort}`
				: supportsEffort && thinking?.defaultEffort && effortLevels.includes(thinking.defaultEffort)
					? `effort:${thinking.defaultEffort}`
					: ""
	const overrideValidation = reasoningOverride ? validateTaskReasoningOverride(reasoningOverride, thinking) : undefined
	const validOverride = overrideValidation?.valid ? overrideValidation.override : undefined
	// A stale override stays persisted for backend validation, but is not presented as a legal selection.
	const configuredThinkingValue =
		overrideValidation?.valid === false
			? ""
			: validOverride?.kind === "effort"
				? `effort:${validOverride.effort}`
				: validOverride?.kind === "budget"
					? "budget"
					: profileThinkingValue
	const configuredBudget =
		validOverride?.kind === "budget"
			? (validOverride.budgetTokens ?? 0)
			: configuredThinkingValue === "budget"
				? (profileReasoning?.thinkingBudget ?? 0)
				: 0
	const configuredServiceTier =
		serviceTierOverride?.kind === "tier" ? serviceTierOverride.tier : resolveProfileServiceTier(profile)
	const [thinkingValue, setThinkingValue] = useState(configuredThinkingValue)
	const [budgetValue, setBudgetValue] = useState(String(configuredBudget))
	const thinkingLabel =
		thinkingValue === "budget"
			? "Budget"
			: thinkingValue.startsWith("effort:")
				? thinkingValue.slice("effort:".length).replace(/^./, (character) => character.toUpperCase())
				: "Thinking"

	useEffect(() => setThinkingValue(configuredThinkingValue), [configuredThinkingValue])
	useEffect(() => setBudgetValue(String(configuredBudget)), [configuredBudget])

	const commit = async (settings: Record<string, string | number>) => {
		if (!taskId) return
		setError(undefined)
		try {
			await updateTaskSettings(taskId, settings)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Failed to update Task runtime settings.")
		}
	}

	const updateThinking = (value: string) => {
		setThinkingValue(value)
		if (value === "budget") return
		const effort = value.slice("effort:".length)
		void commit(
			mode === "plan"
				? { planModeReasoningOverrideKind: "effort", planModeReasoningOverrideEffort: effort }
				: { actModeReasoningOverrideKind: "effort", actModeReasoningOverrideEffort: effort },
		)
	}

	const commitBudget = () => {
		const budgetTokens = budgetValue.trim() === "" ? Number.NaN : Number(budgetValue)
		const validation = validateTaskReasoningOverride({ kind: "budget", budgetTokens }, thinking)
		if (!validation.valid) {
			setError(validation.message)
			return
		}
		void commit(
			mode === "plan"
				? { planModeReasoningOverrideKind: "budget", planModeThinkingBudgetTokens: budgetTokens }
				: { actModeReasoningOverrideKind: "budget", actModeThinkingBudgetTokens: budgetTokens },
		)
	}

	const updateServiceTier = (tier: OpenAiServiceTier) => {
		void commit(
			mode === "plan"
				? { planModeServiceTierOverrideKind: "tier", planModeServiceTierOverrideTier: tier }
				: { actModeServiceTierOverrideKind: "tier", actModeServiceTierOverrideTier: tier },
		)
	}

	const hasTaskControls = Boolean(taskId && (supportsEffort || supportsBudget || supportsServiceTier))
	if (!hasTaskControls) return null

	return (
		<>
			{taskId && (supportsEffort || supportsBudget) && (
				<div
					className="flex h-[18.5px] min-w-0 max-w-full flex-[0_1_auto] items-center justify-center overflow-hidden"
					data-chat-input-slot="thinking">
					<Select onValueChange={updateThinking} value={thinkingValue}>
						<Tooltip>
							<TooltipContent side="top">Thinking: {thinkingLabel}</TooltipContent>
							<TooltipTrigger asChild>
								<div className="inline-flex h-[18.5px] min-w-0 max-w-full items-center">
									<SelectTrigger
										aria-label="Task thinking override"
										className="chat-input-control-outline !h-[18.5px] inline-flex w-auto min-w-0 max-w-full items-center justify-center gap-0 overflow-hidden rounded-sm border-0 bg-toolbar-hover px-1 py-0 text-center text-xs font-medium leading-[18px] text-foreground shadow-none transition-colors duration-150 focus-visible:ring-0"
										showIcon={false}
										size="sm">
										<SelectValue
											className="inline-flex h-full min-w-0 items-center justify-center truncate text-center leading-[18px]"
											placeholder="Thinking"
										/>
									</SelectTrigger>
								</div>
							</TooltipTrigger>
						</Tooltip>
						<SelectContent
							align="start"
							aria-label="Task thinking override options"
							className="min-w-28"
							position="popper"
							side="top"
							sideOffset={4}>
							{supportsEffort &&
								effortLevels.map((effort) => (
									<SelectItem key={effort} value={`effort:${effort}`}>
										{effort.charAt(0).toUpperCase() + effort.slice(1)}
									</SelectItem>
								))}
							{supportsBudget && <SelectItem value="budget">Budget</SelectItem>}
						</SelectContent>
					</Select>
					{thinkingValue === "budget" && supportsBudget && (
						<input
							aria-label="Task thinking budget"
							className="w-20 rounded-sm border border-dropdown-border bg-input-background px-1 py-0.5 text-xs text-input-foreground"
							max={maxBudget}
							min={minBudget}
							onBlur={commitBudget}
							onChange={(event) => setBudgetValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") commitBudget()
							}}
							type="number"
							value={budgetValue}
						/>
					)}
				</div>
			)}
			{taskId && supportsServiceTier ? (
				<TaskServiceTierControl onSelect={updateServiceTier} value={configuredServiceTier} />
			) : null}
			{taskId && error && (
				<span className="text-[10px] text-error" role="status" title={error}>
					{error}
				</span>
			)}
		</>
	)
}
