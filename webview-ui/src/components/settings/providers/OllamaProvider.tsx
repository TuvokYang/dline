import { StringRequest } from "@shared/proto/dline/common"
import { OllamaProviderConfig } from "@shared/proto/dline/provider/ollama"
import { mergeCapabilities } from "@shared/providers/effective-model-info"
// Mode import removed — no longer needed in profile-driven architecture
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useMemo } from "react"
import UseCustomPromptCheckbox from "@/components/settings/UseCustomPromptCheckbox"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { ApiKeyField } from "../common/ApiKeyField"
import { BaseUrlField } from "../common/BaseUrlField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import OllamaModelPicker from "../OllamaModelPicker"
import { ProfileNotice } from "../profile-ui"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { getModelCompatibilityNotice } from "./modelCompatibilityNotice"
import type { ApiProfile } from "./ProviderProfile"
import { useModelProbe } from "./useModelProbe"

interface OllamaProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/** Ollama provider �?all data from ApiProfile. requestTimeoutMs from apiConfiguration (one of 6 remaining fields). */
export const OllamaProvider = ({ showModelOptions, isPopup: _isPopup, profile, onUpdate }: OllamaProviderProps) => {
    const { apiConfiguration } = useExtensionState()
    const { handleFieldChange } = useApiConfigurationHandlers()
    const pc = profile.ollama ?? OllamaProviderConfig.create()

    const baseUrl = profile.baseUrl || ""
    const contextWindow = Number.parseInt(pc.ollamaApiOptionsCtxNum || "32768", 10)
    const compatibilityCapabilities = mergeCapabilities(profile.modelInfo?.capabilities, {
        ...(pc.capabilities ?? {}),
        ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    })
    const compatibilityNotice = getModelCompatibilityNotice({ capabilities: compatibilityCapabilities })

    const probeOllamaModels = useCallback(async () => {
        const response = await ModelsServiceClient.getOllamaModels(StringRequest.create({ value: baseUrl }))
        return response?.values ?? []
    }, [baseUrl])

    const { models: probedModels, refresh: refreshOllamaModels } = useModelProbe({
        credentialsKey: baseUrl,
        enabled: true,
        probe: probeOllamaModels,
        selectedModelId: profile.modelId || undefined,
    })

    // The picker takes plain ids; the current selection is excluded so its
    // placeholder still reports when discovery returned nothing.
    const ollamaModels = useMemo(
        () => Object.keys(probedModels).filter((modelId) => modelId !== profile.modelId),
        [probedModels, profile.modelId],
    )

    return (
        <div className="flex flex-col gap-2">
            <BaseUrlField
                initialValue={profile.baseUrl}
                label="Use custom base URL"
                onChange={(value) => onUpdate({ baseUrl: value || undefined })}
                placeholder="Default: http://localhost:11434"
            />
            {profile.baseUrl && (
                <ApiKeyField
                    helpText="Optional API key for authenticated Ollama instances."
                    initialValue={profile.apiKey}
                    onChange={(value) => onUpdate({ apiKey: value })}
                    placeholder="Enter API Key (optional)..."
                    providerName="Ollama"
                />
            )}
            <label htmlFor="ollama-model-selection">
                <span className="font-semibold">Model</span>
            </label>
            <OllamaModelPicker
                ollamaModels={ollamaModels}
                onFocus={refreshOllamaModels}
                onModelChange={(modelId) => onUpdate({ modelId })}
                placeholder={ollamaModels.length > 0 ? "Search and select a model..." : "e.g. llama3.1"}
                selectedModelId={profile.modelId || ""}
            />
            {ollamaModels.length === 0 && (
                <p className="text-sm mt-1 text-description italic">
                    Unable to fetch models from Ollama server. Please ensure Ollama is running and accessible.
                </p>
            )}
            <DebouncedTextField
                initialValue={pc.ollamaApiOptionsCtxNum || "32768"}
                onChange={(v) => onUpdate({ ollama: { ...pc, ollamaApiOptionsCtxNum: v ?? undefined } })}
                placeholder="e.g. 32768"
                style={{ width: "100%" }}>
                <span className="font-semibold">Model Context Window</span>
            </DebouncedTextField>
            {showModelOptions && (
                <>
                    <DebouncedTextField
                        initialValue={apiConfiguration?.requestTimeoutMs ? String(apiConfiguration.requestTimeoutMs) : "30000"}
                        onChange={(value) => {
                            const n = Number.parseInt(value, 10)
                            if (!Number.isNaN(n) && n > 0) handleFieldChange("requestTimeoutMs", n)
                        }}
                        placeholder="Default: 30000 (30 seconds)"
                        style={{ width: "100%" }}>
                        <span className="font-semibold">Request Timeout (ms)</span>
                    </DebouncedTextField>
                    <p className="text-xs mt-0 text-description">
                        Maximum time in milliseconds to wait for API responses before timing out.
                    </p>
                </>
            )}
            <UseCustomPromptCheckbox providerId="ollama" />
            <p className="text-xs text-description">
                Ollama allows you to run models locally on your computer. See their{" "}
                <VSCodeLink
                    href="https://github.com/ollama/ollama/blob/main/README.md"
                    style={{ display: "inline", fontSize: "inherit" }}>
                    quickstart guide.
                </VSCodeLink>
            </p>
            {compatibilityNotice ? (
                <ProfileNotice title={compatibilityNotice.title} variant={compatibilityNotice.variant}>
                    {compatibilityNotice.message}
                </ProfileNotice>
            ) : null}
        </div>
    )
}
