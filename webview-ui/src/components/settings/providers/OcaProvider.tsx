import { OcaProviderConfig } from "@shared/proto/dline/provider/oca"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { BaseUrlField } from "../common/BaseUrlField"
import ThinkingControl from "../ThinkingControl"
import type { ApiProfile } from "./ProviderProfile"

interface OcaProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/** OCA credentials and reasoning preferences read from the selected Profile declaration. */
export const OcaProvider = ({ showModelOptions, profile, onUpdate }: OcaProviderProps) => {
    const { t } = useUiTranslation()
    const pc = profile.oca ?? OcaProviderConfig.create()
    const modelId = profile.modelId || profile.modelInfo?.id || ""
    const baseModel = profile.modelInfo?.id === modelId ? profile.modelInfo : undefined
    const modelInfo = buildEffectiveModelInfo(modelId, baseModel, { capabilities: pc.capabilities, pricing: pc.pricing })
    const thinking = modelInfo.capabilities?.thinking
    const thinkingSupported = thinking?.supported === true && modelInfo.capabilities?.supportsReasoning !== false
    const effortSupported = thinkingSupported && thinking?.mode === "effort"
    const budgetSupported = thinkingSupported && thinking?.mode === "budget"
    return (
        <div>
            <BaseUrlField
                initialValue={profile.baseUrl}
                label={t("settings.ui.oca.baseUrl")}
                onChange={(v) => onUpdate({ baseUrl: v || undefined })}
                placeholder="https://oca.example.com"
            />
            <VSCodeTextField
                onInput={(e: any) => onUpdate({ apiKey: e.target.value })}
                placeholder={t("settings.ui.enterApiKey")}
                style={{ width: "100%" }}
                type="password"
                value={profile.apiKey}>
                <span style={{ fontWeight: 500 }}>{t("settings.ui.apiKey", { provider: "OCA" })}</span>
            </VSCodeTextField>
            {showModelOptions && (effortSupported || budgetSupported) && (
                <ThinkingControl
                    defaultEffort={thinking?.defaultEffort}
                    defaultEnabled={thinking?.defaultEnabled}
                    disableSupported={thinking?.canDisable !== false}
                    effortOptions={thinking?.effortLevels}
                    maxBudget={thinking?.maxBudget}
                    minBudget={thinking?.minBudget}
                    mode={effortSupported ? "effort-only" : "budget-only"}
                    onReasoningConfigUpdate={(reasoning) => onUpdate({ oca: { ...pc, reasoning } })}
                    reasoningConfig={pc.reasoning}
                    showModeSelector={false}
                />
            )}
        </div>
    )
}
