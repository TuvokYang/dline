import { type ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import { ApiFormat, type ModelCapabilities, type ModelPricing, ServerTool } from "@shared/proto/dline/models/metadata"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { openAiEndpointToApiFormat, resolveApiFormat } from "@shared/providers/api-format"
import { buildEffectiveModelInfo, mergeCapabilities, mergePricing } from "@shared/providers/effective-model-info"
import { DEFAULT_OPENAI_RESPONSES_STREAM_IDLE_TIMEOUT_SECONDS } from "@shared/providers/openai-stream"
import { hasBands } from "@shared/providers/pricing-shape"
import { resolveProfileModelId } from "@shared/providers/profile-model-info"
import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useId, useMemo, useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
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
    const { t } = useUiTranslation()
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
    const [customUrlToggle, setCustomUrlToggle] = useState<{ profileId: string; enabled: boolean }>()
    const customUrlEnabled = customUrlToggle?.profileId === profile.id ? customUrlToggle.enabled : !!profile.baseUrl
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
    const compatibilityNotice = getModelCompatibilityNotice(
        {
            capabilities: compatibilityCapabilities,
            requireCompleteMetadata: customModelEnabled,
        },
        t,
    )
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
                ...(hasBands(updates) ? { pricingTiersEnabled: true } : {}),
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
                enabled={customUrlEnabled}
                initialValue={profile.baseUrl}
                onChange={(value) => onUpdate({ baseUrl: value || undefined })}
                onEnabledChange={(enabled) => setCustomUrlToggle({ profileId: profile.id, enabled })}
                placeholder={t("settings.ui.enterBaseUrl")}
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
                        {t("settings.ui.customModelId")}
                    </VSCodeCheckbox>

                    {customModelEnabled ? (
                        <ProfileField htmlFor={customModelFieldId} label={t("settings.ui.modelId")}>
                            <DebouncedTextField
                                className="w-full"
                                id={customModelFieldId}
                                initialValue={profile.modelId ?? ""}
                                onChange={(value) => onUpdate({ modelId: value })}
                                placeholder={t("settings.ui.enterModelId")}
                            />
                        </ProfileField>
                    ) : (
                        <ModelAutocomplete
                            label={t("settings.ui.model")}
                            models={modelOptions}
                            onChange={handleModelChange}
                            onOpen={refreshRemoteModels}
                            optionOrigins={optionOrigins}
                            placeholder={t("settings.ui.searchModel")}
                            selectedModelId={modelId}
                        />
                    )}

                    <ApiFormatSelector
                        apiFormats={apiFormats}
                        fallbackApiFormat={ApiFormat.OPENAI_CHAT}
                        onChange={(apiFormat) => onUpdate({ openai: { ...configToUpdate(), apiEndpoint: undefined, apiFormat } })}
                        selectedApiFormat={selectedApiFormat}
                    />

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
                            pricing: customUrlEnabled
                                ? ["inputPrice", "outputPrice", "cacheWritesPrice", "cacheReadsPrice", "pricingTiers"]
                                : [],
                        }}
                        key={`${profile.id}:${modelId}`}
                        onCapabilitiesUpdate={handleCapabilitiesUpdate}
                        onDisabledServerToolsUpdate={handleDisabledServerToolsUpdate}
                        onPricingReset={() =>
                            onUpdate({ openai: { ...configToUpdate(), pricing: undefined, pricingTiersEnabled: undefined } })
                        }
                        onPricingUpdate={handlePricingUpdate}
                        pricing={pc.pricing}
                        pricingTiersEnabled={pc.pricingTiersEnabled === true}
                        tiersEditable={true}
                    />
                </>
            )}

            <ProfileSection>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <ProfileSectionTitle>{t("settings.ui.openai.headers")}</ProfileSectionTitle>
                    <ProfileActionRow>
                        <VSCodeButton onClick={addHeader}>{t("settings.ui.openai.addHeader")}</VSCodeButton>
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
                            <ProfileField htmlFor={nameId} label={t("settings.ui.openai.headerName")}>
                                <DebouncedTextField
                                    ariaLabel={t("settings.ui.openai.headerName")}
                                    className="min-h-7 w-full"
                                    id={nameId}
                                    initialValue={key}
                                    onChange={(newValue) => updateHeader(key, newValue, value)}
                                    placeholder={t("settings.ui.openai.headerName")}
                                />
                            </ProfileField>
                            <ProfileField htmlFor={valueId} label={t("settings.ui.openai.headerValue")}>
                                <DebouncedTextField
                                    ariaLabel={t("settings.ui.openai.headerValue")}
                                    className="min-h-7 w-full"
                                    id={valueId}
                                    initialValue={value}
                                    onChange={(newValue) => updateHeader(key, key, newValue)}
                                    placeholder={t("settings.ui.openai.headerValue")}
                                />
                            </ProfileField>
                            <ProfileActionRow className="justify-end xs:self-end">
                                <VSCodeButton appearance="secondary" onClick={() => removeHeader(key)}>
                                    {t("settings.ui.remove")}
                                </VSCodeButton>
                            </ProfileActionRow>
                        </div>
                    )
                })}
            </ProfileSection>

            <BaseUrlField
                initialValue={pc.azureApiVersion}
                label={t("settings.ui.openai.azureVersion")}
                onChange={(value) => onUpdate({ openai: { ...configToUpdate(), azureApiVersion: value } })}
                placeholder={t("settings.ui.defaultValue", { value: "2024-10-01-preview" })}
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
                {t("settings.ui.openai.azureIdentity")}
            </VSCodeCheckbox>

            <ProfileField
                description={t("settings.ui.openai.idleHelp")}
                htmlFor={streamIdleTimeoutId}
                label={t("settings.ui.openai.idleTimeout")}>
                <DebouncedTextField
                    ariaLabel={t("settings.ui.openai.idleTimeout")}
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
