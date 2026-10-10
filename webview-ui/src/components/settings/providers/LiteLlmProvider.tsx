import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { RefreshCwIcon } from "lucide-react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
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
                    placeholder="Default: http://localhost:4000"
                    style={{ width: "100%" }}
                    type="text">
                    <div className="flex items-center gap-2 mb-1">
                        <span style={{ fontWeight: 500 }}>Base URL (optional)</span>
                        {remote?.liteLlmBaseUrl !== undefined && <LockIcon />}
                    </div>
                </DebouncedTextField>
            </RemotelyConfiguredInputWrapper>
            <RemotelyConfiguredInputWrapper hidden={!remote?.configuredApiKeys?.litellm}>
                <DebouncedTextField
                    disabled={remote?.configuredApiKeys?.litellm}
                    initialValue={profile.apiKey}
                    onChange={(value) => onUpdate({ apiKey: value })}
                    placeholder="Default: noop"
                    style={{ width: "100%" }}
                    type="password">
                    <div className="flex items-center gap-2 mb-1">
                        <span style={{ fontWeight: 500 }}>API Key</span>
                        {remote?.configuredApiKeys?.litellm && <LockIcon />}
                    </div>
                </DebouncedTextField>
            </RemotelyConfiguredInputWrapper>
            {showModelOptions && (
                <>
                    <ModelAutocomplete
                        label="Model"
                        models={liteLlmModels}
                        onChange={(newModelId, mi) => onUpdate({ modelId: newModelId, modelInfo: mi })}
                        placeholder="Search or enter a custom model ID..."
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
                            "Loading..."
                        ) : (
                            <>
                                <RefreshCwIcon className="ml-1" />
                                Refresh models
                            </>
                        )}
                    </VSCodeButton>
                    {modelInfo?.capabilities?.supportsReasoning && <></>}
                    {modelInfo && <ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />}
                </>
            )}
            <p style={{ fontSize: "12px", marginTop: "5px", color: "var(--vscode-descriptionForeground)" }}>
                Extended thinking is available for models such as Sonnet-4, o3-mini, Deepseek R1, etc. More info on{" "}
                <VSCodeLink
                    href="https://docs.litellm.ai/docs/reasoning_content"
                    style={{ display: "inline", fontSize: "inherit" }}>
                    thinking mode configuration
                </VSCodeLink>
            </p>
            <p style={{ fontSize: "12px", marginTop: "5px", color: "var(--vscode-descriptionForeground)" }}>
                LiteLLM provides a unified interface to access various LLM providers' models. See their{" "}
                <VSCodeLink href="https://docs.litellm.ai/docs/" style={{ display: "inline", fontSize: "inherit" }}>
                    quickstart guide
                </VSCodeLink>{" "}
                for more information.
            </p>
        </div>
    )
}
