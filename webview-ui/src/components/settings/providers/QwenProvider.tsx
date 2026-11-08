import { QwenApiRegions } from "@shared/api"
import { QwenProviderConfig } from "@shared/proto/dline/provider/qwen"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { resolveProfileCatalogKey, resolveProfileModelId } from "@shared/providers/profile-model-info"
import { QWEN_MAINLAND_CATALOG, resolvePrimaryCatalogKey } from "@shared/providers/provider-catalog-key"
import type { FormEvent } from "react"
import { LocalizedDropdown, LocalizedOption } from "@/components/common/LocalizedDropdown"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { DROPDOWN_Z_INDEX } from "../ApiOptions"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelInfoView } from "../common/ModelInfoView"
import { DropdownContainer } from "../common/ModelSelector"
import ThinkingControl from "../ThinkingControl"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModelOptions } from "./useProviderModelOptions"
import { useProviderModels } from "./useProviderModels"

interface QwenProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

export const qwenApiOptions: QwenApiRegions[] = Object.values(QwenApiRegions)

/** Alibaba Qwen provider all data from ApiProfile. qwenApiLine stored in qwen. */
export const QwenProvider = ({ showModelOptions, isPopup: _isPopup, profile, onUpdate }: QwenProviderProps) => {
    const { t } = useUiTranslation()
    const pc = profile.qwen ?? QwenProviderConfig.create()
    const qwenApiLine = (pc.qwenApiLine as QwenApiRegions) || qwenApiOptions[0]

    // Resolved from the profile so the region option reaches `qwen-cn`; the
    // listing source reads the same key to pick the matching host.
    const {
        models: qwenModels,
        defaultModelId: qwenDefaultModelId,
        options: qwenModelOptions,
        optionOrigins,
        refreshRemoteModels,
    } = useProviderModelOptions({
        providerId: resolveProfileCatalogKey(profile),
        profileId: profile.id,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        selectedModelId: resolveProfileModelId(profile),
    })
    const modelId = resolveProfileModelId(profile, { defaultModelId: qwenDefaultModelId })

    // Switching the API line swaps the catalog. The option has exactly two values,
    // so the catalog being entered is the one this Profile does not read now; both
    // groups are already cached.
    const otherCatalog = useProviderModels(
        qwenApiLine === QwenApiRegions.CHINA ? resolvePrimaryCatalogKey(profile.provider) : QWEN_MAINLAND_CATALOG,
    )
    const changeApiLine = (line: string) => {
        if (line === qwenApiLine) return
        // A selection the new endpoint does not serve would be sent as-is and
        // answered with an error. Fall back to that catalog's default, which
        // `useProviderModels` already reduces to its first model when it states none.
        const fallbackId = otherCatalog.models[modelId] ? modelId : otherCatalog.defaultModelId
        onUpdate({
            qwen: { ...pc, qwenApiLine: line || "" },
            modelId: fallbackId,
            modelInfo: otherCatalog.models[fallbackId],
        })
    }
    const baseModel = profile.modelInfo?.id === modelId ? profile.modelInfo : qwenModels[modelId]
    const modelInfo = buildEffectiveModelInfo(modelId, baseModel, { capabilities: pc.capabilities, pricing: pc.pricing })
    const thinking = modelInfo.capabilities?.thinking
    const budgetSupported =
        thinking?.supported === true && thinking.mode === "budget" && modelInfo.capabilities?.supportsReasoning !== false

    return (
        <div>
            <DropdownContainer className="dropdown-container" style={{ position: "inherit" }}>
                <label htmlFor="qwen-line-provider">
                    <span style={{ fontWeight: 500, marginTop: 5 }}>{t("settings.ui.qwen.line")}</span>
                </label>
                <LocalizedDropdown
                    id="qwen-line-provider"
                    onChange={(e: Event | FormEvent<HTMLElement>) => changeApiLine((e.target as HTMLSelectElement).value)}
                    selectedLabel={
                        qwenApiOptions.includes(qwenApiLine)
                            ? qwenApiLine === QwenApiRegions.CHINA
                                ? t("settings.ui.qwen.chinaApi")
                                : t("settings.ui.qwen.internationalApi")
                            : undefined
                    }
                    style={{ minWidth: 130, position: "relative" }}
                    value={qwenApiLine}>
                    {qwenApiOptions.map((line) => (
                        <LocalizedOption
                            key={line}
                            label={
                                line === QwenApiRegions.CHINA
                                    ? t("settings.ui.qwen.chinaApi")
                                    : t("settings.ui.qwen.internationalApi")
                            }
                            value={line}
                        />
                    ))}
                </LocalizedDropdown>
            </DropdownContainer>
            <p style={{ fontSize: "12px", marginTop: 3, color: "var(--vscode-descriptionForeground)" }}>
                {t("settings.ui.qwen.locationHelp")}
            </p>
            <ApiKeyField
                initialValue={profile.apiKey}
                onChange={(value) => onUpdate({ apiKey: value })}
                providerName="Qwen"
                signupUrl="https://bailian.console.aliyun.com/"
            />
            {showModelOptions && (
                <>
                    <ModelAutocomplete
                        models={qwenModelOptions}
                        onChange={(newModelId) => {
                            // Only catalog entries carry metadata; a discovered id
                            // keeps the profile's existing model info untouched.
                            const nextModel = qwenModels[newModelId]
                            onUpdate({ modelId: newModelId, ...(nextModel ? { modelInfo: nextModel } : {}) })
                        }}
                        onOpen={refreshRemoteModels}
                        optionOrigins={optionOrigins}
                        placeholder={t("settings.ui.searchCustomModel")}
                        selectedModelId={modelId}
                        zIndex={DROPDOWN_Z_INDEX - 2}
                    />
                    {budgetSupported && (
                        <ThinkingControl
                            defaultEnabled={thinking?.defaultEnabled}
                            disableSupported={thinking?.canDisable !== false}
                            maxBudget={thinking?.maxBudget}
                            minBudget={thinking?.minBudget}
                            mode="budget-only"
                            onReasoningConfigUpdate={(reasoning) => onUpdate({ qwen: { ...pc, reasoning } })}
                            reasoningConfig={pc.reasoning}
                            showModeSelector={false}
                        />
                    )}
                    <ModelInfoView isPopup={_isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
                </>
            )}
        </div>
    )
}
