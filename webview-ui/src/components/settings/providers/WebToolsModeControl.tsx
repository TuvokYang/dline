import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { useId } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ProfileField } from "../profile-ui"

interface WebToolsModeControlProps {
    value?: WebToolsMode
    onChange: (value: WebToolsMode) => void
}

const WEB_TOOLS_MODE_OPTIONS = [
    { value: WebToolsMode.WEB_TOOLS_MODE_AUTO, label: "settings.ui.effort.auto" },
    { value: WebToolsMode.WEB_TOOLS_MODE_FORCE_LOCAL, label: "settings.ui.web.localOnly" },
    { value: WebToolsMode.WEB_TOOLS_MODE_FORCE_OFF, label: "settings.ui.web.off" },
    { value: WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE, label: "settings.ui.web.hostedOnly" },
] as const

/**
 * Per-profile routing policy covering every web tool (Web Search and Web Fetch).
 * Changes are persisted by the profile owner.
 */
export function WebToolsModeControl({ value, onChange }: WebToolsModeControlProps) {
    const { t } = useUiTranslation()
    const selectedValue = value ?? WebToolsMode.WEB_TOOLS_MODE_AUTO
    const inputId = useId()

    return (
        <ProfileField htmlFor={inputId} label={t("settings.ui.features.web")}>
            <select
                aria-label={t("settings.ui.web.mode")}
                className="min-h-7 w-full rounded-xs border border-input-border bg-input-background px-2 text-sm"
                id={inputId}
                onChange={(event) => onChange(Number(event.target.value) as WebToolsMode)}
                value={selectedValue}>
                {WEB_TOOLS_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                        {t(option.label)}
                    </option>
                ))}
            </select>
        </ProfileField>
    )
}
