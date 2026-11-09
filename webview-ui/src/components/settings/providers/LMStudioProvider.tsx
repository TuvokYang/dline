import { StringRequest } from "@shared/proto/dline/common"
import { LmStudioProviderConfig } from "@shared/proto/dline/provider/lmstudio"
import { VSCodeLink, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { type FormEvent, useCallback, useMemo } from "react"
import { LocalizedDropdown, LocalizedOption } from "@/components/common/LocalizedDropdown"
import UseCustomPromptCheckbox from "@/components/settings/UseCustomPromptCheckbox"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
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
    const { t } = useUiTranslation()
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
                label={t("settings.ui.baseUrl")}
                onChange={(v) => onUpdate({ baseUrl: v || undefined })}
                placeholder={t("settings.ui.defaultValue", { value: "http://localhost:1234" })}
            />
            <label htmlFor="lmstudio-model">
                <span className="font-semibold">{t("settings.ui.model")}</span>
            </label>
            <DropdownContainer className="dropdown-container">
                {modelOptions.length > 0 ? (
                    <LocalizedDropdown
                        id="lmstudio-model"
                        onChange={(e: Event | FormEvent<HTMLElement>) =>
                            onUpdate({ modelId: (e.target as HTMLInputElement).value })
                        }
                        onFocus={refreshLmStudioModels}
                        selectedLabel={
                            (profile.modelId || "") === ""
                                ? t("settings.ui.selectModel")
                                : modelOptions.find((option) => option.value === profile.modelId)?.label
                        }
                        style={{ width: "100%" }}
                        value={profile.modelId || ""}>
                        <LocalizedOption label={t("settings.ui.selectModel")} value="" />
                        {modelOptions.map((m) => (
                            <VSCodeOption key={m.value} value={m.value}>
                                {m.label}
                            </VSCodeOption>
                        ))}
                    </LocalizedDropdown>
                ) : (
                    <VSCodeTextField
                        id="lmstudio-model"
                        onFocus={refreshLmStudioModels}
                        onInput={(e: any) => onUpdate({ modelId: (e.target as HTMLInputElement).value })}
                        placeholder={t("settings.ui.example", { value: "llama-3.2-3b-instruct" })}
                        style={{ width: "100%" }}
                        value={profile.modelId || ""}
                    />
                )}
            </DropdownContainer>
            {modelOptions.length === 0 && (
                <p className="text-sm mt-1 text-description italic">{t("settings.ui.lmstudio.fetchError")}</p>
            )}
            {showModelOptions && (
                <DebouncedTextField
                    initialValue={pc.lmStudioNumCtx || ""}
                    onChange={(v) => onUpdate({ lmstudio: { ...pc, lmStudioNumCtx: v } })}
                    placeholder={t("settings.ui.example", { value: "4096" })}
                    style={{ width: "100%" }}>
                    <span className="font-semibold">{t("settings.ui.lmstudio.context")}</span>
                </DebouncedTextField>
            )}
            <UseCustomPromptCheckbox providerId="lmstudio" />
            <p style={{ fontSize: "12px", marginTop: "5px", color: "var(--vscode-descriptionForeground)" }}>
                {t("settings.ui.lmstudio.help")}{" "}
                <VSCodeLink href="https://lmstudio.ai/" style={{ display: "inline", fontSize: "inherit" }}>
                    lmstudio.ai
                </VSCodeLink>
            </p>
        </div>
    )
}
