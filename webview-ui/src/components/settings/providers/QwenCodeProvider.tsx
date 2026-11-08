import { QwenCodeProviderConfig } from "@shared/proto/dline/provider/qwen_code"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface QwenCodeProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/** Qwen Code provider â€?all data from ApiProfile. qwenCodeOauthPath stored in providerConfig. */
export const QwenCodeProvider = ({ showModelOptions, isPopup, profile, onUpdate }: QwenCodeProviderProps) => {
    const { t } = useUiTranslation()
    const { models, defaultModelId } = useProviderModels("qwen-code")
    const pc = profile.qwenCode ?? QwenCodeProviderConfig.create()
    const modelInfo = resolveProfileModelInfo(profile, { models, defaultModelId })
    const modelId = modelInfo.id

    return (
        <div>
            <h3 style={{ color: "var(--vscode-foreground)", margin: "8px 0" }}>{t("settings.ui.qwenCode.title")}</h3>
            <VSCodeTextField
                onInput={(e: any) => onUpdate({ qwenCode: { ...pc, qwenCodeOauthPath: e.target.value } })}
                placeholder="~/.qwen/oauth_creds.json"
                style={{ width: "100%" }}
                value={pc.qwenCodeOauthPath ?? ""}>
                {t("settings.ui.qwenCode.path")}
            </VSCodeTextField>
            <div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "4px" }}>
                {t("settings.ui.qwenCode.pathHelp")}
            </div>
            <div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "12px" }}>
                {t("settings.ui.qwenCode.help")}
            </div>
            <div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "8px" }}>
                {t("settings.ui.qwenCode.steps")}
                <br />
                {t("settings.ui.qwenCode.install")}
                <br />
                {t("settings.ui.qwenCode.authenticate")}
                <br />
                {t("settings.ui.qwenCode.store")}
            </div>
            <VSCodeLink
                href="https://github.com/QwenLM/qwen-code/blob/main/README.md"
                style={{
                    color: "var(--vscode-textLink-foreground)",
                    marginTop: "8px",
                    display: "inline-block",
                    fontSize: "12px",
                }}>
                {t("settings.ui.setupInstructions")}
            </VSCodeLink>
            {showModelOptions && (
                <>
                    <ModelSelector
                        models={models}
                        onChange={(e) => {
                            const v = (e.target as HTMLSelectElement).value
                            onUpdate({ modelId: v, modelInfo: models[v] })
                        }}
                        selectedModelId={modelId}
                    />
                    <ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
                </>
            )}
        </div>
    )
}
