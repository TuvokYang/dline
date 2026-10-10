import { StringRequest } from "@shared/proto/dline/common"
import { LmStudioProviderConfig } from "@shared/proto/dline/provider/lmstudio"
import { VSCodeDropdown, VSCodeLink, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useMemo } from "react"
import UseCustomPromptCheckbox from "@/components/settings/UseCustomPromptCheckbox"
import { ModelsServiceClient } from "@/services/grpc-client"
import { BaseUrlField } from "../common/BaseUrlField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { DropdownContainer } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useModelProbe } from "./useModelProbe"

interface LMStudioProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/** LM Studio provider �?baseUrl, apiKey, modelId from ApiProfile. */
export const LMStudioProvider = ({ showModelOptions, isPopup: _isPopup, profile, onUpdate }: LMStudioProviderProps) => {
    const pc = profile.lmstudio ?? LmStudioProviderConfig.create()

    const probeLmStudioModels = useCallback(async () => {
        const response = await ModelsServiceClient.getLmStudioModels(StringRequest.create({ value: profile.baseUrl ?? "" }))
        return response?.values ?? []
    }, [profile.baseUrl])

    const { models: probedModels, refresh: refreshLmStudioModels } = useModelProbe({
        credentialsKey: profile.baseUrl ?? "",
        enabled: true,
        probe: probeLmStudioModels,
        selectedModelId: profile.modelId || undefined,
    })

    // The manual-entry fallback must stay reachable when discovery finds
    // nothing, so the current selection alone does not count as an option.
    const modelOptions = useMemo(
        () =>
            Object.keys(probedModels)
                .filter((modelId) => modelId !== profile.modelId)
                .map((modelId) => ({ value: modelId, label: modelId })),
        [probedModels, profile.modelId],
    )

    return (
        <div className="flex flex-col gap-2">
            <BaseUrlField
                initialValue={profile.baseUrl}
                label="Base URL"
                onChange={(v) => onUpdate({ baseUrl: v || undefined })}
                placeholder="Default: http://localhost:1234"
            />
            <label htmlFor="lmstudio-model">
                <span className="font-semibold">Model</span>
            </label>
            <DropdownContainer className="dropdown-container">
                {modelOptions.length > 0 ? (
                    <VSCodeDropdown
                        id="lmstudio-model"
                        onChange={(e) => onUpdate({ modelId: (e.target as HTMLInputElement).value })}
                        onFocus={refreshLmStudioModels}
                        style={{ width: "100%" }}
                        value={profile.modelId || ""}>
                        <VSCodeOption value="">Select a model...</VSCodeOption>
                        {modelOptions.map((m) => (
                            <VSCodeOption key={m.value} value={m.value}>
                                {m.label}
                            </VSCodeOption>
                        ))}
                    </VSCodeDropdown>
                ) : (
                    <VSCodeTextField
                        id="lmstudio-model"
                        onFocus={refreshLmStudioModels}
                        onInput={(e: any) => onUpdate({ modelId: (e.target as HTMLInputElement).value })}
                        placeholder="e.g. llama-3.2-3b-instruct"
                        style={{ width: "100%" }}
                        value={profile.modelId || ""}
                    />
                )}
            </DropdownContainer>
            {modelOptions.length === 0 && (
                <p className="text-sm mt-1 text-description italic">
                    Unable to fetch models from LM Studio. Ensure LM Studio is running or enter model ID manually.
                </p>
            )}
            {showModelOptions && (
                <DebouncedTextField
                    initialValue={pc.lmStudioNumCtx || ""}
                    onChange={(v) => onUpdate({ lmstudio: { ...pc, lmStudioNumCtx: v } })}
                    placeholder="e.g. 4096"
                    style={{ width: "100%" }}>
                    <span className="font-semibold">Context Length</span>
                </DebouncedTextField>
            )}
            <UseCustomPromptCheckbox providerId="lmstudio" />
            <p style={{ fontSize: "12px", marginTop: "5px", color: "var(--vscode-descriptionForeground)" }}>
                LM Studio runs models locally. See{" "}
                <VSCodeLink href="https://lmstudio.ai/" style={{ display: "inline", fontSize: "inherit" }}>
                    lmstudio.ai
                </VSCodeLink>{" "}
                for setup.
            </p>
        </div>
    )
}
