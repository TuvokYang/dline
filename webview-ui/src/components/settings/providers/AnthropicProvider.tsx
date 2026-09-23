import type { ModelCapabilities, ModelPricing, ServerTool } from "@shared/proto/dline/models/metadata"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { AnthropicProviderConfig } from "@shared/proto/dline/provider/anthropic"
import {
	buildEffectiveModelInfo,
	mergeCapabilities,
	mergePricing,
	selectContextTier,
	updateSelectedContextWindow,
} from "@shared/providers/effective-model-info"
import {
	ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS,
	canDisableClaudeAdaptiveThinking,
	isClaudeAdaptiveThinkingEnabledByDefault,
} from "@shared/utils/reasoning-support"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useId } from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ApiKeyField } from "../common/ApiKeyField"
import { BaseUrlField } from "../common/BaseUrlField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelConfiguration } from "../common/ModelConfiguration"
import { ModelInfoView } from "../common/ModelInfoView"
import { RemotelyConfiguredInputWrapper } from "../common/RemotelyConfiguredInputWrapper"
import { ProfileField } from "../profile-ui"
import ThinkingControl from "../ThinkingControl"
import { ANTHROPIC_THINKING_DISPLAY_DESCRIPTION, ANTHROPIC_THINKING_DISPLAY_SELECTOR_OPTIONS } from "./anthropicThinkingDisplay"
import { ClaudeCodeIdentitySection } from "./shared/ClaudeCodeIdentitySection"
import { useProviderModelOptions } from "./useProviderModelOptions"

const StyledCheckbox = styled(VSCodeCheckbox)`
	margin-bottom: 4px;
`

/**
 * Props for the AnthropicProvider component
 */
interface AnthropicProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/**
 * The Anthropic provider configuration component.
 * All data sourced from ApiProfile.anthropic (the proto oneof field) â€? * typed as AnthropicProviderConfig | undefined, no unsafe casts.
 */
export const AnthropicProvider = ({ showModelOptions, isPopup, profile, onUpdate }: AnthropicProviderProps) => {
	const customModelFieldId = useId()
	const { remoteConfigSettings } = useExtensionState()
	const rc: Partial<Record<string, string | number | boolean>> =
		(remoteConfigSettings as Record<string, string | number | boolean>) ?? {}

	const {
		models: anthropicModels,
		defaultModelId: anthropicDefaultModelId,
		modelInfoSaneDefaults: anthropicModelInfoSaneDefaults,
		options: anthropicModelOptions,
		optionOrigins,
		refreshRemoteModels,
	} = useProviderModelOptions({
		providerId: "anthropic",
		profileId: profile.id,
		baseUrl: profile.baseUrl,
		apiKey: profile.apiKey,
		selectedModelId: profile.modelId,
	})

	const pc = profile.anthropic ?? AnthropicProviderConfig.create()
	const modelId = profile.modelId || anthropicDefaultModelId
	// The user owns this switch. Deriving it from catalog membership would flip
	// it on for any id that only the provider's listing returned, and the
	// resulting custom-model metadata would then mask the catalog's own
	// capabilities, including its hosted server tools.
	const customModelEnabled = pc.customModelEnabled === true
	const registryModel = anthropicModels[modelId] ?? anthropicModelInfoSaneDefaults
	const contextWindowTiersEnabled = customModelEnabled || Boolean(registryModel.capabilities?.contextWindowTiers?.length)
	// The 1M long-context option is enabled by default; only an explicit false disables it.
	const enableLongContext = pc.enableLongContext !== false
	const modelInfo = buildEffectiveModelInfo(modelId, registryModel, {
		capabilities: pc.capabilities,
		pricing: pc.pricing,
		enableLongContext,
		pricingTiersEnabled: pc.pricingTiersEnabled,
		preferContextWindowTier: true,
		contextWindowTiersEnabled,
	})
	const selectedContextTier = selectContextTier(modelInfo.capabilities, enableLongContext)
	const contextWindowValue = selectedContextTier?.contextWindow ?? modelInfo.capabilities?.contextWindow

	const adaptiveEffortOptions = modelInfo.capabilities?.thinking?.effortLevels ?? []
	const isAdaptiveThinkingModel =
		modelInfo.capabilities?.thinking?.supported === true &&
		modelInfo.capabilities.thinking.mode === "effort" &&
		adaptiveEffortOptions.length > 0
	const adaptiveThinkingDefaultEnabled = !customModelEnabled && isClaudeAdaptiveThinkingEnabledByDefault(modelId)
	const adaptiveThinkingDisableSupported = customModelEnabled || canDisableClaudeAdaptiveThinking(modelId)

	// --- Handlers ---
	/** Commits a model id from the merged picker without touching the custom-model switch. */
	const handleModelChange = (newModelId: string) => {
		onUpdate({ modelId: newModelId })
	}

	/**
	 * Turning the switch on replaces the picker with a free-form id field.
	 * The id is kept so toggling back and forth does not discard the selection.
	 */
	const handleToggleCustomModel = (enabled: boolean) => {
		onUpdate({ anthropic: { ...pc, customModelEnabled: enabled } })
	}

	// Update provider capabilities without writing profile.modelInfo.
	const handleCapabilitiesUpdate = (updates: Partial<ModelCapabilities>) => {
		onUpdate({
			anthropic: {
				...pc,
				capabilities: mergeCapabilities(pc.capabilities, updates),
			},
		})
	}

	// Update provider pricing without writing profile.modelInfo.
	const handleContextWindowUpdate = (contextWindow: number) => {
		onUpdate({
			anthropic: {
				...pc,
				capabilities: updateSelectedContextWindow(
					registryModel.capabilities,
					pc.capabilities,
					enableLongContext,
					contextWindow,
					contextWindowTiersEnabled,
				),
			},
		})
	}

	const handlePricingUpdate = (updates: Partial<ModelPricing>) => {
		onUpdate({
			anthropic: {
				...pc,
				pricing: mergePricing(pc.pricing, updates),
				...(updates.tiers === undefined ? {} : { pricingTiersEnabled: true }),
			},
		})
	}

	// Record the hosted tools this profile turns off. The model's own declaration
	// stays in the registry so the switch can never erase a real capability.
	const handleDisabledServerToolsUpdate = (disabledServerTools: ServerTool[]) => {
		onUpdate({ anthropic: { ...pc, disabledServerTools } })
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(value) => onUpdate({ apiKey: value })}
				providerName="Anthropic"
				signupUrl="https://console.anthropic.com/settings/keys"
			/>

			<RemotelyConfiguredInputWrapper hidden={rc.anthropicBaseUrl === undefined}>
				<BaseUrlField
					disabled={!!rc.anthropicBaseUrl}
					initialValue={profile.baseUrl || ""}
					label="Use custom base URL"
					onChange={(value) => onUpdate({ baseUrl: value || undefined })}
					placeholder="Default: https://api.anthropic.com"
					showLockIcon={!!rc.anthropicBaseUrl}
				/>
			</RemotelyConfiguredInputWrapper>

			{showModelOptions && (
				<>
					<StyledCheckbox
						checked={customModelEnabled}
						onChange={(event: Event | React.FormEvent<HTMLElement>) =>
							handleToggleCustomModel((event.target as HTMLInputElement | null)?.checked === true)
						}>
						Use custom model ID
					</StyledCheckbox>

					{customModelEnabled ? (
						<ProfileField htmlFor={customModelFieldId} label="Model ID">
							<DebouncedTextField
								className="w-full"
								id={customModelFieldId}
								initialValue={profile.modelId ?? ""}
								onChange={(value) => onUpdate({ modelId: value })}
								placeholder="Enter Model ID..."
							/>
						</ProfileField>
					) : (
						<ModelAutocomplete
							label="Model"
							models={anthropicModelOptions}
							onChange={handleModelChange}
							onOpen={refreshRemoteModels}
							optionOrigins={optionOrigins}
							placeholder="Search or select a model..."
							selectedModelId={modelId}
						/>
					)}

					{modelInfo.capabilities?.contextWindowTiers?.length ? (
						<StyledCheckbox
							checked={pc.enableLongContext !== false}
							onChange={(event: Event | React.FormEvent<HTMLElement>) =>
								onUpdate({
									anthropic: {
										...pc,
										enableLongContext: (event.target as HTMLInputElement | null)?.checked === true,
									},
								})
							}>
							Enable Long Context
						</StyledCheckbox>
					) : null}

					{isAdaptiveThinkingModel && (
						<ThinkingControl
							defaultEffort={adaptiveThinkingDefaultEnabled ? "high" : undefined}
							defaultEnabled={adaptiveThinkingDefaultEnabled}
							disableSupported={adaptiveThinkingDisableSupported}
							displayDescription={ANTHROPIC_THINKING_DISPLAY_DESCRIPTION}
							displayLabel="Thinking Display"
							displayOptions={ANTHROPIC_THINKING_DISPLAY_SELECTOR_OPTIONS}
							effortDescription={
								adaptiveThinkingDisableSupported
									? "Use None to disable adaptive thinking. Higher effort increases response detail and token usage."
									: "Adaptive thinking is always enabled for this model. Higher effort increases response detail and token usage."
							}
							effortLabel="Adaptive Thinking"
							effortOptions={
								adaptiveEffortOptions.length > 0
									? adaptiveEffortOptions
									: ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS
							}
							maxBudget={modelInfo.capabilities?.thinking?.maxBudget}
							mode={customModelEnabled ? "both" : "effort-only"}
							modeSelectorLabel="Thinking Mode"
							modeSelectorOptions={[
								{ value: "effort", label: "Effort" },
								{ value: "budget", label: "Budget" },
							]}
							onReasoningConfigUpdate={(reasoning) => {
								onUpdate({ anthropic: { ...pc, reasoning } })
							}}
							reasoningConfig={pc.reasoning}
							showModeSelector={customModelEnabled}
						/>
					)}

					<ModelConfiguration
						capabilities={pc.capabilities}
						contextWindowValue={contextWindowValue}
						defaults={registryModel}
						disabledServerTools={pc.disabledServerTools}
						fields={{
							capabilities: [
								"maxTokens",
								"contextWindow",
								...(contextWindowTiersEnabled ? (["contextWindowTiers"] as const) : []),
								"supportsImages",
								"hostedWebSearch",
								"hostedWebFetch",
								"supportsBrowserAction",
								"supportsPromptCache",
								"supportsTools",
							],
							pricing: ["inputPrice", "outputPrice", "cacheWritesPrice", "cacheReadsPrice", "pricingTiers"],
						}}
						onCapabilitiesUpdate={handleCapabilitiesUpdate}
						onContextWindowUpdate={handleContextWindowUpdate}
						onDisabledServerToolsUpdate={handleDisabledServerToolsUpdate}
						onPricingUpdate={handlePricingUpdate}
						pricing={pc.pricing}
						pricingTiersEnabled={pc.pricingTiersEnabled === true}
						// Official models show registry tiers editable; custom models can add their own tiers.
						tiersEditable={true}
					/>

					<ClaudeCodeIdentitySection
						config={pc.claudeCodeIdentity}
						onChange={(claudeCodeIdentity) => onUpdate({ anthropic: { ...pc, claudeCodeIdentity } })}
					/>

					<ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
				</>
			)}
		</div>
	)
}
