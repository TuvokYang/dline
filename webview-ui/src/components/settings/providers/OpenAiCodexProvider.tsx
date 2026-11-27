import { ApiFormat, type ModelCapabilities, type ModelPricing } from "@shared/proto/dline/models/metadata"
import { OpenAiCodexProviderConfig } from "@shared/proto/dline/provider/openai_codex"
import { resolveApiFormat } from "@shared/providers/api-format"
import { buildEffectiveModelInfo, mergeCapabilities, mergePricing } from "@shared/providers/effective-model-info"
import { inheritModelInfo } from "@shared/providers/model-inheritance"
import { resolveOpenAIModel } from "@shared/providers/openai-model-info"
import { resolveProfileModelId } from "@shared/providers/profile-model-info"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
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
    const { t } = useUiTranslation()
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
        selectedModelId: resolveProfileModelId(profile),
    })
    const modelId = resolveProfileModelId(profile, { defaultModelId })
    const registryModel = models[modelId]
    const rawModel = profile.modelInfo?.id === modelId ? profile.modelInfo : registryModel
    // Retain the declared layer for help attribution; inherited effort levels are
    // declarations too, even when they equal the generic compatibility choices.
    const declaredModel = inheritModelInfo(modelId, rawModel, models, "gpt")
    const baseModel = resolveOpenAIModel(modelId, rawModel, models)
    const modelInfo = buildEffectiveModelInfo(modelId, baseModel, {
        capabilities: pc.capabilities,
        pricing: pc.pricing,
    })
    const thinking = modelInfo.capabilities?.thinking
    const thinkingSupported = thinking?.supported === true && modelInfo.capabilities?.supportsReasoning !== false
    const effortSupported = thinkingSupported && thinking?.mode === "effort"
    const budgetSupported = thinkingSupported && thinking?.mode === "budget"
    const compatibilityThinking =
        declaredModel.capabilities?.thinking === undefined && pc.capabilities?.thinking === undefined && effortSupported
    const supportedApiFormats = baseModel?.apiFormats ?? modelInfoSaneDefaults.apiFormats ?? [ApiFormat.OPENAI_RESPONSES]
    const apiFormats = supportedApiFormats.length > 0 ? supportedApiFormats : [ApiFormat.OPENAI_RESPONSES]
    const selectedApiFormat = resolveApiFormat(pc.apiFormat, { apiFormats }, ApiFormat.OPENAI_RESPONSES)
    const websocketEnabled = selectedApiFormat === ApiFormat.OPENAI_RESPONSES && pc.websocketEnabled === true
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
                        models={modelOptions}
                        onChange={(value) => onUpdate({ modelId: value, modelInfo: models[value] })}
                        onOpen={refreshRemoteModels}
                        optionOrigins={optionOrigins}
                        placeholder={t("settings.ui.searchCustomModel")}
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
                    {selectedApiFormat === ApiFormat.OPENAI_RESPONSES ? (
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
                            {t("settings.ui.useWebsocket")}
                        </VSCodeCheckbox>
                    ) : null}
                    {(effortSupported || budgetSupported) && (
                        <ThinkingControl
                            defaultEffort={thinking?.defaultEffort}
                            defaultEnabled={thinking?.defaultEnabled}
                            disableSupported={thinking?.canDisable !== false}
                            effortDescription={
                                compatibilityThinking ? t("settings.ui.openai.compatibilityThinkingHelp") : undefined
                            }
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
