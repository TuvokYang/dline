import { ZAiProviderConfig } from "@shared/proto/dline/provider/zai"
import { resolveProfileCatalogKey, resolveProfileModelId, resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { resolvePrimaryCatalogKey, ZAI_MAINLAND_CATALOG } from "@shared/providers/provider-catalog-key"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelInfoView } from "../common/ModelInfoView"
import { DropdownContainer } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModelOptions } from "./useProviderModelOptions"
import { useProviderModels } from "./useProviderModels"

interface ZAiProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/** Z AI provider �?all data from ApiProfile. zaiApiLine stored in providerConfig. */
export const ZAiProvider = ({ showModelOptions, isPopup, profile, onUpdate }: ZAiProviderProps) => {
    const { t } = useUiTranslation()
    const pc = profile.zai ?? ZAiProviderConfig.create()
    const zaiApiLine = pc.zaiApiLine || "international"

    // The catalog key is resolved from the profile, not hard-coded: the region
    // option selects `zai-cn`, and a literal key named the international catalog
    // would leave a mainland Profile reading a catalog the registry never holds.
    const {
        models: zaiModels,
        defaultModelId: zaiDefaultModelId,
        options: zaiModelOptions,
        optionOrigins,
        refreshRemoteModels,
    } = useProviderModelOptions({
        providerId: resolveProfileCatalogKey(profile),
        profileId: profile.id,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        selectedModelId: resolveProfileModelId(profile),
    })
    const modelInfo = resolveProfileModelInfo(profile, { models: zaiModels, defaultModelId: zaiDefaultModelId })
    const modelId = modelInfo.id

    // A region change swaps the catalog. The region option has exactly two values,
    // so the catalog being entered is always the one this Profile does not read
    // now; both groups are already cached, so this costs no extra request.
    const otherCatalog = useProviderModels(
        zaiApiLine === "china" ? resolvePrimaryCatalogKey(profile.provider) : ZAI_MAINLAND_CATALOG,
    )
    const changeEntrypoint = (line: string) => {
        if (line === zaiApiLine) return
        // A selection the new endpoint does not serve would be sent as-is and
        // answered with an error. Fall back to that catalog's default, which
        // `useProviderModels` already reduces to its first model when it states none.
        const fallbackId = otherCatalog.models[modelId] ? modelId : otherCatalog.defaultModelId
        onUpdate({
            zai: { ...pc, zaiApiLine: line },
            modelId: fallbackId,
            modelInfo: otherCatalog.models[fallbackId],
        })
    }

    return (
        <div>
            <DropdownContainer className="dropdown-container" style={{ position: "inherit" }}>
                <label htmlFor="zai-entrypoint">
                    <span style={{ fontWeight: 500, marginTop: 5 }}>{t("settings.ui.zai.entrypoint")}</span>
                </label>
                <VSCodeDropdown
                    id="zai-entrypoint"
                    onChange={(e) => changeEntrypoint((e.target as HTMLSelectElement).value)}
                    style={{ minWidth: 130, position: "relative" }}
                    value={zaiApiLine}>
                    <VSCodeOption value="international">api.z.ai</VSCodeOption>
                    <VSCodeOption value="china">open.bigmodel.cn</VSCodeOption>
                </VSCodeDropdown>
            </DropdownContainer>
            <p style={{ fontSize: "12px", marginTop: 3, color: "var(--vscode-descriptionForeground)" }}>
                {t("settings.ui.zai.locationHelp")}
            </p>
            <ApiKeyField
                initialValue={profile.apiKey}
                onChange={(value) => onUpdate({ apiKey: value })}
                providerName="Z AI"
                signupUrl={
                    zaiApiLine === "china"
                        ? "https://open.bigmodel.cn/console/overview"
                        : "https://z.ai/manage-apikey/apikey-list"
                }
            />
            {showModelOptions && (
                <>
                    <ModelAutocomplete
                        models={zaiModelOptions}
                        onChange={(newModelId) => {
                            // Only catalog entries carry metadata; a discovered id
                            // keeps the profile's existing model info untouched.
                            const nextModel = zaiModels[newModelId]
                            onUpdate({ modelId: newModelId, ...(nextModel ? { modelInfo: nextModel } : {}) })
                        }}
                        onOpen={refreshRemoteModels}
                        optionOrigins={optionOrigins}
                        placeholder={t("settings.ui.searchCustomModel")}
                        selectedModelId={modelId}
                    />
                    <ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
                </>
            )}
        </div>
    )
}
