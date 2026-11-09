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
import { hasBands } from "@shared/providers/pricing-shape"
import { resolveProfileModelId } from "@shared/providers/profile-model-info"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useId, useMemo, useState } from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ApiKeyField } from "../common/ApiKeyField"
import { BaseUrlField } from "../common/BaseUrlField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelConfiguration } from "../common/ModelConfiguration"
import { ModelInfoView } from "../common/ModelInfoView"
import { RemotelyConfiguredInputWrapper } from "../common/RemotelyConfiguredInputWrapper"
import { ProfileField } from "../profile-ui"
import ThinkingControl from "../ThinkingControl"
import { anthropicThinkingDisplayOptions } from "./anthropicThinkingDisplay"
import { ClaudeCodeIdentitySection } from "./shared/ClaudeCodeIdentitySection"
import { usePendingProviderConfig } from "./usePendingProviderConfig"
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
export const AnthropicProvider = ({ showModelOptions, isPopup, profile, onUpdate: onUpdateProfile }: AnthropicProviderProps) => {
    const customModelFieldId = useId()
    const [customUrlToggle, setCustomUrlToggle] = useState<{ profileId: string; enabled: boolean }>()
    const customUrlEnabled = customUrlToggle?.profileId === profile.id ? customUrlToggle.enabled : !!profile.baseUrl
    const { remoteConfigSettings } = useExtensionState()
    const rc: Partial<Record<string, string | number | boolean>> =
        (remoteConfigSettings as Record<string, string | number | boolean>) ?? {}

    const {
        models: anthropicModels,
        defaultModelId: anthropicDefaultModelId,
        options: anthropicModelOptions,
        optionOrigins,
        refreshRemoteModels,
    } = useProviderModelOptions({
        providerId: "anthropic",
        profileId: profile.id,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        selectedModelId: resolveProfileModelId(profile),
    })

    const propConfig = useMemo(() => profile.anthropic ?? AnthropicProviderConfig.create(), [profile.anthropic])
    const { config: pc, latest: configToUpdate, publish } = usePendingProviderConfig(profile.id, propConfig)
    const onUpdate = useCallback(
        (updates: Partial<ApiProfile>) => {
            if (updates.anthropic) publish(updates.anthropic)
            onUpdateProfile(updates)
        },
        [onUpdateProfile, publish],
    )
    const modelId = resolveProfileModelId(profile, { defaultModelId: anthropicDefaultModelId })
    // The user owns this switch. Deriving it from catalog membership would flip
    // it on for any id that only the provider's listing returned, and the
    // resulting custom-model metadata would then mask the catalog's own
    // capabilities, including its hosted server tools.
    const { t } = useUiTranslation()
    const customModelEnabled = pc.customModelEnabled === true
    const registryModel = anthropicModels[modelId] ?? (profile.modelInfo?.id === modelId ? profile.modelInfo : { id: modelId })
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

    const thinking = modelInfo.capabilities?.thinking
    const thinkingSupported = thinking?.supported === true && modelInfo.capabilities?.supportsReasoning !== false
    const isAdaptiveThinkingModel = thinkingSupported && thinking?.mode === "effort"
    const budgetThinkingSupported = thinkingSupported && thinking?.mode === "budget"
    const thinkingDisableSupported = thinking?.canDisable !== false

    // --- Handlers ---
    /** Commits a model id from the merged picker without touching the custom-model switch. */
    const handleModelChange = (newModelId: string) => {
        onUpdate({ modelId: newModelId, modelInfo: anthropicModels[newModelId] })
    }

    /**
     * Turning the switch on replaces the picker with a free-form id field.
     * The id is kept so toggling back and forth does not discard the selection.
     */
    const handleToggleCustomModel = (enabled: boolean) => {
        onUpdate({ anthropic: { ...configToUpdate(), customModelEnabled: enabled } })
    }

    // Update provider capabilities without writing profile.modelInfo.
    const handleCapabilitiesUpdate = (updates: Partial<ModelCapabilities>) => {
        onUpdate({
            anthropic: {
                ...configToUpdate(),
                capabilities: mergeCapabilities(configToUpdate().capabilities, updates),
            },
        })
    }

    // Update provider pricing without writing profile.modelInfo.
    const handleContextWindowUpdate = (contextWindow: number) => {
        onUpdate({
            anthropic: {
                ...configToUpdate(),
                capabilities: updateSelectedContextWindow(
                    registryModel.capabilities,
                    configToUpdate().capabilities,
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
                ...configToUpdate(),
                pricing: mergePricing(configToUpdate().pricing, updates),
                ...(hasBands(updates) ? { pricingTiersEnabled: true } : {}),
            },
        })
    }

    // Record the hosted tools this profile turns off. The model's own declaration
    // stays in the registry so the switch can never erase a real capability.
    const handleDisabledServerToolsUpdate = (disabledServerTools: ServerTool[]) => {
        onUpdate({ anthropic: { ...configToUpdate(), disabledServerTools } })
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
                    enabled={customUrlEnabled}
                    initialValue={profile.baseUrl || ""}
                    onChange={(value) => onUpdate({ baseUrl: value || undefined })}
                    onEnabledChange={(enabled) => setCustomUrlToggle({ profileId: profile.id, enabled })}
                    placeholder={t("settings.ui.defaultValue", { value: "https://api.anthropic.com" })}
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
                        {t("settings.ui.customModelId")}
                    </StyledCheckbox>

                    {customModelEnabled ? (
                        <ProfileField htmlFor={customModelFieldId} label={t("settings.ui.modelId")}>
                            <DebouncedTextField
                                className="w-full"
                                id={customModelFieldId}
                                initialValue={profile.modelId ?? ""}
                                onChange={handleModelChange}
                                placeholder={t("settings.ui.enterModelId")}
                            />
                        </ProfileField>
                    ) : (
                        <ModelAutocomplete
                            models={anthropicModelOptions}
                            onChange={handleModelChange}
                            onOpen={refreshRemoteModels}
                            optionOrigins={optionOrigins}
                            placeholder={t("settings.ui.searchModel")}
                            selectedModelId={modelId}
                        />
                    )}

                    {modelInfo.capabilities?.contextWindowTiers?.length ? (
                        <StyledCheckbox
                            checked={pc.enableLongContext !== false}
                            onChange={(event: Event | React.FormEvent<HTMLElement>) =>
                                onUpdate({
                                    anthropic: {
                                        ...configToUpdate(),
                                        enableLongContext: (event.target as HTMLInputElement | null)?.checked === true,
                                    },
                                })
                            }>
                            {t("settings.ui.anthropic.longContext")}
                        </StyledCheckbox>
                    ) : null}

                    {(isAdaptiveThinkingModel || budgetThinkingSupported) && (
                        <ThinkingControl
                            defaultEffort={thinking?.defaultEffort}
                            defaultEnabled={thinking?.defaultEnabled}
                            disableSupported={thinkingDisableSupported}
                            displayDescription={t("settings.ui.anthropic.displayHelp")}
                            displayLabel={t("settings.ui.thinkingDisplay")}
                            displayOptions={anthropicThinkingDisplayOptions(t)}
                            effortDescription={
                                thinkingDisableSupported
                                    ? t("settings.ui.anthropic.effortHelp")
                                    : t("settings.ui.anthropic.requiredHelp")
                            }
                            effortLabel={t("settings.ui.adaptiveThinking")}
                            effortOptions={thinking?.effortLevels ?? []}
                            maxBudget={thinking?.maxBudget}
                            minBudget={thinking?.minBudget}
                            mode={isAdaptiveThinkingModel ? "effort-only" : "budget-only"}
                            onReasoningConfigUpdate={(reasoning) => {
                                onUpdate({ anthropic: { ...configToUpdate(), reasoning } })
                            }}
                            reasoningConfig={pc.reasoning}
                            showModeSelector={false}
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
                            pricing: customUrlEnabled
                                ? ["inputPrice", "outputPrice", "cacheWritesPrice", "cacheReadsPrice", "pricingTiers"]
                                : [],
                        }}
                        key={`${profile.id}:${modelId}`}
                        onCapabilitiesUpdate={handleCapabilitiesUpdate}
                        onContextWindowUpdate={handleContextWindowUpdate}
                        onDisabledServerToolsUpdate={handleDisabledServerToolsUpdate}
                        onPricingReset={() =>
                            onUpdate({ anthropic: { ...configToUpdate(), pricing: undefined, pricingTiersEnabled: undefined } })
                        }
                        onPricingUpdate={handlePricingUpdate}
                        pricing={pc.pricing}
                        pricingTiersEnabled={pc.pricingTiersEnabled === true}
                        // Official models show registry tiers editable; custom models can add their own tiers.
                        tiersEditable={true}
                    />

                    <ClaudeCodeIdentitySection
                        config={pc.claudeCodeIdentity}
                        onChange={(claudeCodeIdentity) => onUpdate({ anthropic: { ...configToUpdate(), claudeCodeIdentity } })}
                    />

                    <ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
                </>
            )}
        </div>
    )
}
