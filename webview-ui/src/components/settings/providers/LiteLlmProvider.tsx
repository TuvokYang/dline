import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { RefreshCwIcon } from "lucide-react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelInfoView } from "../common/ModelInfoView"
import { LockIcon, RemotelyConfiguredInputWrapper } from "../common/RemotelyConfiguredInputWrapper"
import type { ApiProfile } from "./ProviderProfile"

interface LiteLlmProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

export const LiteLlmProvider = ({ showModelOptions, isPopup, profile, onUpdate }: LiteLlmProviderProps) => {
    const { t } = useUiTranslation()
    const { remoteConfigSettings, liteLlmModels, refreshLiteLlmModels } = useExtensionState()
    const remote = remoteConfigSettings as any
    const [isLoading, setIsLoading] = useState(false)
    const modelInfo = profile.modelInfo as any
    const modelId = profile.modelId

    return (
        <div>
            <RemotelyConfiguredInputWrapper hidden={remote?.liteLlmBaseUrl === undefined}>
                <DebouncedTextField
                    disabled={remote?.liteLlmBaseUrl !== undefined}
                    initialValue={profile.baseUrl || ""}
                    onChange={(value) => onUpdate({ baseUrl: value || undefined })}
                    placeholder={t("settings.ui.defaultValue", { value: "http://localhost:4000" })}
                    style={{ width: "100%" }}
                    type="text">
                    <div className="flex items-center gap-2 mb-1">
                        <span style={{ fontWeight: 500 }}>{t("settings.ui.optionalBaseUrl")}</span>
                        {remote?.liteLlmBaseUrl !== undefined && <LockIcon />}
                    </div>
                </DebouncedTextField>
            </RemotelyConfiguredInputWrapper>
            <RemotelyConfiguredInputWrapper hidden={!remote?.configuredApiKeys?.litellm}>
                <DebouncedTextField
                    disabled={remote?.configuredApiKeys?.litellm}
                    initialValue={profile.apiKey}
                    onChange={(value) => onUpdate({ apiKey: value })}
                    placeholder={t("settings.ui.defaultValue", { value: "noop" })}
                    style={{ width: "100%" }}
                    type="password">
                    <div className="flex items-center gap-2 mb-1">
                        <span style={{ fontWeight: 500 }}>{t("settings.ui.aws.apiKey")}</span>
                        {remote?.configuredApiKeys?.litellm && <LockIcon />}
                    </div>
                </DebouncedTextField>
            </RemotelyConfiguredInputWrapper>
            {showModelOptions && (
                <>
                    <ModelAutocomplete
                        models={liteLlmModels}
                        onChange={(newModelId, mi) => onUpdate({ modelId: newModelId, modelInfo: mi })}
                        placeholder={t("settings.ui.searchOrEnterModel")}
                        selectedModelId={modelId}
                    />
                    <VSCodeButton
                        className={`my-2 ${isLoading ? "animate-pulse" : ""}`}
                        disabled={isLoading}
                        onClick={async () => {
                            setIsLoading(true)
                            try {
                                await refreshLiteLlmModels()
                            } finally {
                                setIsLoading(false)
                            }
                        }}>
                        {isLoading ? (
                            t("settings.ui.loading")
                        ) : (
                            <>
                                <RefreshCwIcon className="ml-1" />
                                {t("settings.ui.refreshModels")}
                            </>
                        )}
                    </VSCodeButton>
                    {modelInfo?.capabilities?.supportsReasoning && <></>}
                    {modelInfo && <ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />}
                </>
            )}
            <p style={{ fontSize: "12px", marginTop: "5px", color: "var(--vscode-descriptionForeground)" }}>
                {t("settings.ui.litellm.thinkingHelp")}{" "}
                <VSCodeLink
                    href="https://docs.litellm.ai/docs/reasoning_content"
                    style={{ display: "inline", fontSize: "inherit" }}>
                    {t("settings.ui.litellm.thinkingLink")}
                </VSCodeLink>
            </p>
            <p style={{ fontSize: "12px", marginTop: "5px", color: "var(--vscode-descriptionForeground)" }}>
                {t("settings.ui.litellm.help")}{" "}
                <VSCodeLink href="https://docs.litellm.ai/docs/" style={{ display: "inline", fontSize: "inherit" }}>
                    {t("settings.ui.quickstart")}
                </VSCodeLink>
            </p>
        </div>
    )
}
