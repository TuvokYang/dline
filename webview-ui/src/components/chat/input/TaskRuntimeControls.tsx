import { useApiProfiles } from "@components/settings/providers/useApiProfiles"
import { useProviderModels } from "@components/settings/providers/useProviderModels"
import { updateTaskSettings } from "@components/settings/utils/settingsHandlers"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@components/ui/tooltip"
import { useExtensionState } from "@context/ExtensionStateContext"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import type { OpenAiServiceTier } from "@shared/storage/types"
import { profileServiceTierEnabled, resolveProfileServiceTier } from "@shared/task-provider-overrides"
import { resolveProfileReasoningConfig, resolveTaskThinkingConfig } from "@shared/task-reasoning"
import { useEffect, useMemo, useState } from "react"
import { TaskServiceTierControl } from "./TaskServiceTierControl"

/** Task-local reasoning and OpenAI service-tier controls for the chat input toolbar. */
export function TaskRuntimeControls() {
	const { apiConfiguration, currentTaskItem, mode, taskViewState } = useExtensionState()
	const { profiles } = useApiProfiles()
	const [error, setError] = useState<string>()

	const taskId = taskViewState?.taskId ?? currentTaskItem?.id
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
	const thinking = resolveTaskThinkingConfig(
		profile?.provider,
		effectiveModelInfo?.capabilities,
		profileReasoning,
		effectiveModelInfo?.id ?? profile?.modelId,
	)
	const effortLevels = thinking?.effortLevels ?? []
	const maxBudget = thinking?.maxBudget
	const supportsEffort = effortLevels.length > 0
	const supportsBudget = Number.isSafeInteger(maxBudget) && (maxBudget ?? -1) >= 0
	const supportsServiceTier = profileServiceTierEnabled(profile)

	const reasoningOverride =
		mode === "plan" ? apiConfiguration?.planModeReasoningOverride : apiConfiguration?.actModeReasoningOverride
	const serviceTierOverride =
		mode === "plan" ? apiConfiguration?.planModeServiceTierOverride : apiConfiguration?.actModeServiceTierOverride
	const profileThinkingValue =
		(profileReasoning?.thinkingBudget ?? 0) > 0
			? "budget"
			: profileReasoning?.effort
				? `effort:${profileReasoning.effort}`
				: supportsEffort
					? `effort:${effortLevels.includes("medium") ? "medium" : effortLevels[0]}`
					: supportsBudget
						? "budget"
						: ""
	const configuredThinkingValue =
		reasoningOverride?.kind === "effort"
			? `effort:${reasoningOverride.effort ?? ""}`
			: reasoningOverride?.kind === "budget"
				? "budget"
				: profileThinkingValue
	const configuredBudget =
		reasoningOverride?.kind === "budget"
			? (reasoningOverride.budgetTokens ?? 0)
			: profileThinkingValue === "budget"
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
		const budgetTokens = Number(budgetValue)
		if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 0 || budgetTokens > (maxBudget ?? -1)) {
			setError(`Thinking budget must be an integer between 0 and ${maxBudget ?? 0}.`)
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
										<SelectValue className="inline-flex h-full min-w-0 items-center justify-center truncate text-center leading-[18px]" />
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
							min={0}
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
