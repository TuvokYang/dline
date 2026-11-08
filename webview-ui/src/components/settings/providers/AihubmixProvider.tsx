// Mode import removed — no longer needed in profile-driven architecture
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface AIhubmixProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

export const AIhubmixProvider = ({ showModelOptions, isPopup, profile, onUpdate }: AIhubmixProviderProps) => {
    const { t } = useUiTranslation()
    const { models, defaultModelId } = useProviderModels("aihubmix")
    const modelInfo = resolveProfileModelInfo(profile, { models, defaultModelId })
    const modelId = modelInfo.id
    return (
        <div>
            <ApiKeyField
                initialValue={profile.apiKey}
                onChange={(v) => onUpdate({ apiKey: v })}
                providerName="AIHubMix"
                signupUrl="https://aihubmix.com/"
            />
            <DebouncedTextField
                initialValue={profile.baseUrl || ""}
                onChange={(v) => onUpdate({ baseUrl: v || undefined })}
                placeholder={t("settings.ui.enterBaseUrl")}
                style={{ width: "100%" }}
                type="text">
                <span style={{ fontWeight: 500 }}>{t("settings.ui.optionalBaseUrl")}</span>
            </DebouncedTextField>
            {showModelOptions && (
                <>
                    <ModelSelector
                        models={models}
                        onChange={(e) =>
                            onUpdate({
                                modelId: (e.target as HTMLSelectElement).value,
                                modelInfo: models[(e.target as HTMLSelectElement).value],
                            })
                        }
                        selectedModelId={modelId}
                    />
                    <ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
                </>
            )}
        </div>
    )
}
