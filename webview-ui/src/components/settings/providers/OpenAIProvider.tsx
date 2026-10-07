import { type ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import { ApiFormat, type ModelCapabilities, type ModelPricing, ServerTool } from "@shared/proto/dline/models/metadata"
import { OpenAiPromptCacheMode, OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { openAiEndpointToApiFormat, resolveApiFormat } from "@shared/providers/api-format"
import { buildEffectiveModelInfo, mergeCapabilities, mergePricing } from "@shared/providers/effective-model-info"
import { DEFAULT_OPENAI_RESPONSES_STREAM_IDLE_TIMEOUT_SECONDS } from "@shared/providers/openai-stream"
import { resolveProfileModelId } from "@shared/providers/profile-model-info"
import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useId, useMemo } from "react"
import { ApiFormatSelector } from "../common/ApiFormatSelector"
import { ApiKeyField } from "../common/ApiKeyField"
import { BaseUrlField } from "../common/BaseUrlField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelConfiguration } from "../common/ModelConfiguration"
import { ModelInfoView } from "../common/ModelInfoView"
import OpenAIServiceTierSelector from "../OpenAIServiceTierSelector"
import { ProfileActionRow, ProfileField, ProfileNotice, ProfileSection, ProfileSectionTitle } from "../profile-ui"
import ThinkingControl from "../ThinkingControl"
import { getModelCompatibilityNotice } from "./modelCompatibilityNotice"
import type { ApiProfile } from "./ProviderProfile"
import { ProviderWebToolsSettings } from "./ProviderWebToolsSettings"
import { usePendingProviderConfig } from "./usePendingProviderConfig"
import { useProviderModelOptions } from "./useProviderModelOptions"

interface OpenAIProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

const CUSTOM_OPENAI_API_FORMATS = [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES]

function getOpenAiConfig(profile: ApiProfile): OpenAiProviderConfig {
	return profile.openai ?? OpenAiProviderConfig.create({ streamIncludeUsage: true })
}

/** Unified OpenAI API-key provider for official and custom OpenAI-compatible models. */
export const OpenAIProvider = ({ showModelOptions, isPopup, profile, onUpdate: onUpdateProfile }: OpenAIProviderProps) => {
	// Every field below rebuilds the whole config from `pc`. Debounced inputs
	// commit on independent timers, so without this the second commit would
	// rebuild from a prop that has not yet received the first one.
	// A stable reference per profile lets the hook tell renders apart.
	const propConfig = useMemo(() => getOpenAiConfig(profile), [profile])
	const { config: pc, latest, publish } = usePendingProviderConfig(profile.id, propConfig)
	const onUpdate = useCallback(
		(updates: Partial<ApiProfile>) => {
			if (updates.openai) {
				publish(updates.openai)
			}
			onUpdateProfile(updates)
		},
		[onUpdateProfile, publish],
	)
	/**
	 * Base config for an update that replaces the whole provider config.
	 *
	 * Callers spread this and override the field they own. Reading the newest
	 * published config rather than this render's prop keeps a field committed
	 * moments earlier, whose save has not been echoed back yet, from being
	 * rebuilt away.
	 */
	const configToUpdate = useCallback(() => latest(), [latest])
	const fieldId = useId()
	const streamIdleTimeoutId = `${fieldId}-stream-idle-timeout`
	const customModelFieldId = `${fieldId}-custom-model-id`
	const {
		models,
		defaultModelId,
		modelInfoSaneDefaults,
		options: modelOptions,
		optionOrigins,
		refreshRemoteModels,
	} = useProviderModelOptions({
		providerId: "openai",
		profileId: profile.id,
		baseUrl: profile.baseUrl,
		apiKey: profile.apiKey,
		selectedModelId: resolveProfileModelId(profile),
	})
	// The user owns this switch. Deriving it from catalog membership would flip
	// it on for any id that only the provider's listing returned, and the
	// resulting custom-model metadata would then mask the catalog's own
	// capabilities, including its hosted server tools.
	const customModelEnabled = pc.customModelEnabled === true
	const modelId = resolveProfileModelId(profile, customModelEnabled ? undefined : { defaultModelId })
	const registryModel = customModelEnabled ? undefined : models[modelId]
	const matchingModel = profile.modelInfo?.id === modelId ? profile.modelInfo : undefined
	const baseModel = matchingModel ?? registryModel ?? openAiModelInfoSaneDefaults
	const modelInfo: ModelInfo = buildEffectiveModelInfo(modelId, baseModel, {
		capabilities: pc.capabilities,
		pricing: pc.pricing,
		enableLongContext: pc.enableLongContext,
		pricingTiersEnabled: pc.pricingTiersEnabled,
	})
	const compatibilityCapabilities = customModelEnabled
		? mergeCapabilities(matchingModel?.capabilities, pc.capabilities ?? {})
		: modelInfo.capabilities
	const compatibilityNotice = getModelCompatibilityNotice({
		capabilities: compatibilityCapabilities,
		requireCompleteMetadata: customModelEnabled,
	})
	const apiFormats =
		registryModel?.apiFormats ??
		(customModelEnabled ? profile.modelInfo?.apiFormats : undefined) ??
		(customModelEnabled ? openAiModelInfoSaneDefaults.apiFormats : modelInfoSaneDefaults.apiFormats) ??
		CUSTOM_OPENAI_API_FORMATS
	const selectedApiFormat = resolveApiFormat(
		pc.apiFormat ?? openAiEndpointToApiFormat(pc.apiEndpoint),
		{ apiFormats },
		ApiFormat.OPENAI_CHAT,
	)
	const hostedWebSearchAvailable =
		modelInfo.capabilities?.tools?.includes(ServerTool.WEB_SEARCH) === true &&
		(selectedApiFormat === ApiFormat.OPENAI_RESPONSES || selectedApiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE)
	const thinking = modelInfo.capabilities?.thinking
	const thinkingSupported = thinking?.supported === true && modelInfo.capabilities?.supportsReasoning !== false
	const effortSupported = thinkingSupported && thinking?.mode === "effort"
	const budgetSupported = thinkingSupported && thinking?.mode === "budget"
	const openAiHeaders = pc.openAiHeaders ?? {}
	const headerEntries: [string, string][] = Object.entries(openAiHeaders)

	const addHeader = useCallback(() => {
		const current = { ...openAiHeaders }
		current[`header${Object.keys(current).length + 1}`] = ""
		onUpdate({ openai: { ...configToUpdate(), openAiHeaders: current } })
	}, [configToUpdate, onUpdate, openAiHeaders])

	const removeHeader = useCallback(
		(key: string) => {
			const { [key]: _, ...rest } = openAiHeaders
			onUpdate({ openai: { ...configToUpdate(), openAiHeaders: rest } })
		},
		[configToUpdate, onUpdate, openAiHeaders],
	)

	const updateHeader = useCallback(
		(oldKey: string, newKey: string, value: string) => {
			const { [oldKey]: _, ...rest } = openAiHeaders
			if (newKey) rest[newKey] = value
			onUpdate({ openai: { ...configToUpdate(), openAiHeaders: rest } })
		},
		[configToUpdate, onUpdate, openAiHeaders],
	)

	const handleCapabilitiesUpdate = (updates: Partial<ModelCapabilities>) => {
		const base = configToUpdate()
		onUpdate({ openai: { ...base, capabilities: mergeCapabilities(base.capabilities, updates) } })
	}

	const handlePricingUpdate = (updates: Partial<ModelPricing>) => {
		const base = configToUpdate()
		onUpdate({
			openai: {
				...base,
				pricing: mergePricing(base.pricing, updates),
				...(updates.tiers === undefined ? {} : { pricingTiersEnabled: true }),
			},
		})
	}

	// Record the hosted tools this profile turns off. The model's own declaration
	// stays in the registry so the switch can never erase a real capability.
	const handleDisabledServerToolsUpdate = (disabledServerTools: ServerTool[]) => {
		onUpdate({ openai: { ...configToUpdate(), disabledServerTools } })
	}

	const handleStreamIdleTimeoutChange = (value: string) => {
		const seconds = Number.parseInt(value, 10)
		if (!Number.isSafeInteger(seconds) || seconds <= 0) return
		onUpdate({ openai: { ...configToUpdate(), streamIdleTimeoutSeconds: seconds } })
	}

	/**
	 * Commits a model id from the merged picker.
	 *
	 * A listed model keeps its catalog-driven formats; an id that only the
	 * provider's listing returned falls back to the formats a custom
	 * OpenAI-compatible endpoint supports.
	 */
	const handleModelChange = (nextModelId: string) => {
		const nextModel = models[nextModelId]
		const nextFormats = nextModel?.apiFormats ?? CUSTOM_OPENAI_API_FORMATS
		onUpdate({
			modelId: nextModelId,
			openai: {
				...configToUpdate(),
				apiEndpoint: undefined,
				apiFormat: resolveApiFormat(selectedApiFormat, { apiFormats: nextFormats }, ApiFormat.OPENAI_CHAT),
			},
		})
	}

	/**
	 * Turning the switch on replaces the picker with a free-form id field.
	 * The id is kept so toggling back and forth does not discard the selection.
	 */
	const handleToggleCustomModel = (enabled: boolean) => {
		onUpdate({ openai: { ...configToUpdate(), customModelEnabled: enabled } })
	}

	return (
		<div className="flex min-w-0 flex-col gap-3">
			<BaseUrlField
				initialValue={profile.baseUrl}
				label="Use custom base URL"
				onChange={(value) => onUpdate({ baseUrl: value || undefined })}
				placeholder="Enter base URL..."
			/>

			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(value) => onUpdate({ apiKey: value })}
				providerName="OpenAI"
				signupUrl="https://platform.openai.com/api-keys"
			/>

			{showModelOptions && (
				<>
					<VSCodeCheckbox
						checked={customModelEnabled}
						onChange={(event: Event | React.FormEvent<HTMLElement>) =>
							handleToggleCustomModel((event.target as HTMLInputElement | null)?.checked === true)
						}>
						Use custom model ID
					</VSCodeCheckbox>

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
							models={modelOptions}
							onChange={handleModelChange}
							onOpen={refreshRemoteModels}
							optionOrigins={optionOrigins}
							placeholder="Search or select a model..."
							selectedModelId={modelId}
						/>
					)}

					<ApiFormatSelector
						apiFormats={apiFormats}
						fallbackApiFormat={ApiFormat.OPENAI_CHAT}
						onChange={(apiFormat) => onUpdate({ openai: { ...configToUpdate(), apiEndpoint: undefined, apiFormat } })}
						selectedApiFormat={selectedApiFormat}
					/>

					<VSCodeCheckbox
						checked={pc.promptCacheMode === OpenAiPromptCacheMode.OPENAI_PROMPT_CACHE_MODE_EXPLICIT}
						onChange={(event: Event | React.FormEvent<HTMLElement>) =>
							onUpdate({
								openai: {
									...configToUpdate(),
									promptCacheMode: (event.target as HTMLInputElement | null)?.checked
										? OpenAiPromptCacheMode.OPENAI_PROMPT_CACHE_MODE_EXPLICIT
										: OpenAiPromptCacheMode.OPENAI_PROMPT_CACHE_MODE_AUTOMATIC,
								},
							})
						}>
						Use explicit prompt cache controls
					</VSCodeCheckbox>
					<p style={{ fontSize: 12, marginTop: 0, color: "var(--vscode-descriptionForeground)" }}>
						Enable only when the selected endpoint supports prompt_cache_breakpoint. Rejected controls fall back to
						automatic caching for the current task.
					</p>

					<ProviderWebToolsSettings
						hostedAvailable={hostedWebSearchAvailable}
						onChange={(webToolsMode) => onUpdate({ webToolsMode })}
						value={profile.webToolsMode}
					/>

					{(effortSupported || budgetSupported) && (
						<ThinkingControl
							defaultEffort={thinking?.defaultEffort}
							defaultEnabled={thinking?.defaultEnabled}
							disableSupported={thinking?.canDisable !== false}
							effortOptions={thinking?.effortLevels}
							maxBudget={thinking?.maxBudget}
							minBudget={thinking?.minBudget}
							mode={effortSupported ? "effort-only" : "budget-only"}
							onReasoningConfigUpdate={(reasoning) => onUpdate({ openai: { ...configToUpdate(), reasoning } })}
							reasoningConfig={pc.reasoning}
							showModeSelector={false}
						/>
					)}

					<OpenAIServiceTierSelector
						onServiceTierChange={(serviceTier) => onUpdate({ openai: { ...configToUpdate(), serviceTier } })}
						onServiceTierEnabledChange={(serviceTierEnabled) =>
							onUpdate({ openai: { ...configToUpdate(), serviceTierEnabled } })
						}
						serviceTier={pc.serviceTier}
						serviceTierEnabled={pc.serviceTierEnabled}
					/>

					<ModelConfiguration
						capabilities={pc.capabilities}
						defaults={baseModel}
						disabledServerTools={pc.disabledServerTools}
						fields={{
							// OpenAI models are controlled directly by context size; they have no
							// context-window tiers. Pricing tiers are usage-based tiered pricing.
							capabilities: [
								"maxTokens",
								"contextWindow",
								"supportsImages",
								"hostedWebSearch",
								...(customModelEnabled ? (["supportsBrowserAction"] as const) : []),
								"supportsPromptCache",
								"supportsTools",
								"temperature",
							],
							pricing: ["inputPrice", "outputPrice", "cacheWritesPrice", "cacheReadsPrice", "pricingTiers"],
						}}
						onCapabilitiesUpdate={handleCapabilitiesUpdate}
						onDisabledServerToolsUpdate={handleDisabledServerToolsUpdate}
						onPricingUpdate={handlePricingUpdate}
						pricing={pc.pricing}
						pricingTiersEnabled={pc.pricingTiersEnabled === true}
						tiersEditable={true}
					/>
				</>
			)}

			<ProfileSection>
				<div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
					<ProfileSectionTitle>Custom Headers</ProfileSectionTitle>
					<ProfileActionRow>
						<VSCodeButton onClick={addHeader}>Add Header</VSCodeButton>
					</ProfileActionRow>
				</div>
				{headerEntries.map(([key, value], index) => {
					const nameId = `${fieldId}-header-${index}-name`
					const valueId = `${fieldId}-header-${index}-value`
					return (
						<div
							className="grid min-w-0 grid-cols-1 gap-2 xs:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
							data-testid="custom-header-row"
							key={`${key}-${index}`}>
							<ProfileField htmlFor={nameId} label="Header name">
								<DebouncedTextField
									ariaLabel="Header name"
									className="min-h-7 w-full"
									id={nameId}
									initialValue={key}
									onChange={(newValue) => updateHeader(key, newValue, value)}
									placeholder="Header name"
								/>
							</ProfileField>
							<ProfileField htmlFor={valueId} label="Header value">
								<DebouncedTextField
									ariaLabel="Header value"
									className="min-h-7 w-full"
									id={valueId}
									initialValue={value}
									onChange={(newValue) => updateHeader(key, key, newValue)}
									placeholder="Header value"
								/>
							</ProfileField>
							<ProfileActionRow className="justify-end xs:self-end">
								<VSCodeButton appearance="secondary" onClick={() => removeHeader(key)}>
									Remove
								</VSCodeButton>
							</ProfileActionRow>
						</div>
					)
				})}
			</ProfileSection>

			<BaseUrlField
				initialValue={pc.azureApiVersion}
				label="Set Azure API version"
				onChange={(value) => onUpdate({ openai: { ...configToUpdate(), azureApiVersion: value } })}
				placeholder="Default: 2024-10-01-preview"
			/>

			<VSCodeCheckbox
				checked={pc.azureIdentity ?? false}
				onChange={(event: Event | React.FormEvent<HTMLElement>) =>
					onUpdate({
						openai: {
							...configToUpdate(),
							azureIdentity: (event.target as HTMLInputElement | null)?.checked === true,
						},
					})
				}>
				Use Azure Identity Authentication
			</VSCodeCheckbox>

			<VSCodeCheckbox
				checked={pc.streamIncludeUsage ?? true}
				onChange={(event: Event | React.FormEvent<HTMLElement>) =>
					onUpdate({
						openai: {
							...configToUpdate(),
							streamIncludeUsage: (event.target as HTMLInputElement | null)?.checked === true,
						},
					})
				}>
				Include usage stats in stream responses
			</VSCodeCheckbox>

			<ProfileField
				description="Abort and retry when no Responses streaming event is received for this many seconds."
				htmlFor={streamIdleTimeoutId}
				label="Responses stream idle timeout (seconds)">
				<DebouncedTextField
					ariaLabel="Responses stream idle timeout (seconds)"
					className="min-h-7 w-full"
					id={streamIdleTimeoutId}
					initialValue={String(pc.streamIdleTimeoutSeconds ?? DEFAULT_OPENAI_RESPONSES_STREAM_IDLE_TIMEOUT_SECONDS)}
					onChange={handleStreamIdleTimeoutChange}
					placeholder={String(DEFAULT_OPENAI_RESPONSES_STREAM_IDLE_TIMEOUT_SECONDS)}
				/>
			</ProfileField>

			{compatibilityNotice ? (
				<ProfileNotice title={compatibilityNotice.title} variant={compatibilityNotice.variant}>
					{compatibilityNotice.message}
				</ProfileNotice>
			) : null}

			{showModelOptions && <ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />}
		</div>
	)
}
