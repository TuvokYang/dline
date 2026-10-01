import { ApiFormat, type ModelCapabilities, type ModelPricing } from "@shared/proto/dline/models/metadata"
import { OpenAiCodexProviderConfig } from "@shared/proto/dline/provider/openai_codex"
import { resolveApiFormat } from "@shared/providers/api-format"
import { buildEffectiveModelInfo, mergeCapabilities, mergePricing } from "@shared/providers/effective-model-info"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { ApiFormatSelector } from "../common/ApiFormatSelector"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelConfiguration } from "../common/ModelConfiguration"
import { ModelInfoView } from "../common/ModelInfoView"
import OpenAIServiceTierSelector from "../OpenAIServiceTierSelector"
import ThinkingControl from "../ThinkingControl"
import { OpenAiCodexOAuthControl } from "./OpenAiCodexOAuthControl"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModelOptions } from "./useProviderModelOptions"

interface OpenAiCodexProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/**
 * Helper: returns the proto-generated openaiCodex provider config.
 *
 * The runtime provider id is "openai-codex", while the generated ApiProfile field
 * remains openaiCodex because proto field names cannot contain hyphens.
 */
function getCodexConfig(profile: ApiProfile): OpenAiCodexProviderConfig {
	return profile.openaiCodex ?? OpenAiCodexProviderConfig.create()
}

export const OpenAiCodexProvider = ({ showModelOptions, isPopup, profile, onUpdate }: OpenAiCodexProviderProps) => {
	const pc = getCodexConfig(profile)
	const {
		models,
		defaultModelId,
		modelInfoSaneDefaults,
		options: modelOptions,
		optionOrigins,
		refreshRemoteModels,
	} = useProviderModelOptions({
		providerId: "openai-codex",
		profileId: profile.id,
		baseUrl: profile.baseUrl,
		apiKey: profile.apiKey,
		selectedModelId: profile.modelId,
	})
	const modelId = profile.modelId || defaultModelId
	const registryModel = models[modelId]
	const baseModel = profile.modelInfo?.id === modelId ? profile.modelInfo : registryModel
	const modelInfo = buildEffectiveModelInfo(modelId, baseModel, {
		capabilities: pc.capabilities,
		pricing: pc.pricing,
	})
	const thinking = modelInfo.capabilities?.thinking
	const thinkingSupported = thinking?.supported === true && modelInfo.capabilities?.supportsReasoning !== false
	const effortSupported = thinkingSupported && thinking?.mode === "effort"
	const budgetSupported = thinkingSupported && thinking?.mode === "budget"
	const supportedApiFormats = baseModel?.apiFormats ?? modelInfoSaneDefaults.apiFormats ?? [ApiFormat.OPENAI_RESPONSES]
	const baseApiFormats = supportedApiFormats.filter((apiFormat) => apiFormat !== ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE)
	const apiFormats = baseApiFormats.length > 0 ? baseApiFormats : [ApiFormat.OPENAI_RESPONSES]
	const legacyWebsocketEnabled = pc.apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE
	const selectedApiFormat = resolveApiFormat(
		legacyWebsocketEnabled ? ApiFormat.OPENAI_RESPONSES : pc.apiFormat,
		{ apiFormats },
		ApiFormat.OPENAI_RESPONSES,
	)
	const websocketSupported = supportedApiFormats.includes(ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE)
	const websocketEnabled = websocketSupported && (pc.websocketEnabled ?? legacyWebsocketEnabled)
	const handleCapabilitiesUpdate = (updates: Partial<ModelCapabilities>) => {
		onUpdate({ openaiCodex: { ...pc, capabilities: mergeCapabilities(pc.capabilities, updates) } })
	}
	const handlePricingUpdate = (updates: Partial<ModelPricing>) => {
		onUpdate({ openaiCodex: { ...pc, pricing: mergePricing(pc.pricing, updates) } })
	}
	return (
		<div className="flex flex-col gap-4">
			<OpenAiCodexOAuthControl profileId={profile.id} />
			{showModelOptions && (
				<>
					<ModelAutocomplete
						label="Model"
						models={modelOptions}
						onChange={(value) => onUpdate({ modelId: value, modelInfo: models[value] })}
						onOpen={refreshRemoteModels}
						optionOrigins={optionOrigins}
						placeholder="Search, select, or enter a model ID..."
						selectedModelId={modelId}
					/>
					<ApiFormatSelector
						apiFormats={apiFormats}
						fallbackApiFormat={ApiFormat.OPENAI_RESPONSES}
						onChange={(apiFormat) =>
							onUpdate({
								openaiCodex: {
									...pc,
									apiFormat,
									websocketEnabled: apiFormat === ApiFormat.OPENAI_RESPONSES ? websocketEnabled : false,
								},
							})
						}
						selectedApiFormat={selectedApiFormat}
						showSingleOption
					/>
					{websocketSupported && selectedApiFormat === ApiFormat.OPENAI_RESPONSES ? (
						<VSCodeCheckbox
							checked={websocketEnabled}
							onChange={(event) =>
								onUpdate({
									openaiCodex: {
										...pc,
										apiFormat: ApiFormat.OPENAI_RESPONSES,
										websocketEnabled: (event.target as HTMLInputElement).checked,
									},
								})
							}>
							Use WebSocket transport
						</VSCodeCheckbox>
					) : null}
					{(effortSupported || budgetSupported) && (
						<ThinkingControl
							defaultEffort={thinking?.defaultEffort}
							defaultEnabled={thinking?.defaultEnabled}
							disableSupported={thinking?.canDisable !== false}
							effortOptions={thinking?.effortLevels}
							maxBudget={thinking?.maxBudget}
							minBudget={thinking?.minBudget}
							mode={effortSupported ? "effort-only" : "budget-only"}
							onReasoningConfigUpdate={(reasoning) => onUpdate({ openaiCodex: { ...pc, reasoning } })}
							reasoningConfig={pc.reasoning}
							showModeSelector={false}
						/>
					)}
					<OpenAIServiceTierSelector
						onServiceTierChange={(serviceTier) => onUpdate({ openaiCodex: { ...pc, serviceTier } })}
						onServiceTierEnabledChange={(serviceTierEnabled) =>
							onUpdate({ openaiCodex: { ...pc, serviceTierEnabled } })
						}
						serviceTier={pc.serviceTier}
						serviceTierEnabled={pc.serviceTierEnabled !== false}
					/>
					<ModelConfiguration
						capabilities={pc.capabilities}
						defaults={baseModel}
						fields={{ capabilities: ["contextWindow", "maxTokens"] }}
						onCapabilitiesUpdate={handleCapabilitiesUpdate}
						onPricingUpdate={handlePricingUpdate}
						pricing={pc.pricing}
					/>
					<ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
				</>
			)}
		</div>
	)
}
