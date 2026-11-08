import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { DebouncedTextField } from "../common/DebouncedTextField"
import type { ApiProfile } from "./ProviderProfile"

interface ImageGenerationProfileSettingsEditorProps {
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

type Settings = NonNullable<ApiProfile["imageGeneration"]>
type NumericSetting = keyof Settings

function parseOptionalNumber(value: string, integer: boolean, minimum: number): number | undefined | null {
    if (!value.trim()) return undefined
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < minimum || (integer && !Number.isSafeInteger(parsed))) return null
    return parsed
}

export const ImageGenerationProfileSettingsEditor = ({ profile, onUpdate }: ImageGenerationProfileSettingsEditorProps) => {
    const { t } = useUiTranslation()
    const updateSetting = (key: NumericSetting, value: string, integer: boolean, minimum: number): void => {
        const parsed = parseOptionalNumber(value, integer, minimum)
        if (parsed === null) return
        onUpdate({ imageGeneration: { ...profile.imageGeneration, [key]: parsed } })
    }

    return (
        <div className="mt-2 rounded border border-editor-widget-border/30 p-2">
            <div className="mb-1 text-xs font-medium">{t("settings.ui.imageProfiles.limits")}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <DebouncedTextField
                    initialValue={profile.imageGeneration?.taskBudgetUsd?.toString() ?? ""}
                    onChange={(value) => updateSetting("taskBudgetUsd", value, false, 0)}
                    placeholder={t("settings.ui.imageProfiles.unlimited")}>
                    <span>{t("settings.ui.imageProfiles.budget")}</span>
                </DebouncedTextField>
                <DebouncedTextField
                    initialValue={profile.imageGeneration?.requestTimeoutMs?.toString() ?? "180000"}
                    onChange={(value) => updateSetting("requestTimeoutMs", value, true, 1)}>
                    <span>{t("settings.ui.imageProfiles.timeout")}</span>
                </DebouncedTextField>
                <DebouncedTextField
                    initialValue={profile.imageGeneration?.maxConcurrentRequests?.toString() ?? "1"}
                    onChange={(value) => updateSetting("maxConcurrentRequests", value, true, 1)}>
                    <span>{t("settings.ui.imageProfiles.concurrent")}</span>
                </DebouncedTextField>
            </div>
            <p className="mb-0 mt-1 text-xs text-description">{t("settings.ui.imageProfiles.limitsHelp")}</p>
        </div>
    )
}
