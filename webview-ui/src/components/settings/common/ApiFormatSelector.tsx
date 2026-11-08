import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { getApiFormatLabel, resolveApiFormat } from "@shared/providers/api-format"
import { useId } from "react"
import { nativeSelectOptionStyle, nativeSelectStyle } from "@/components/ui/native-select-theme"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ProfileField } from "../profile-ui"

interface ApiFormatSelectorProps {
    apiFormats: ApiFormat[] | undefined
    selectedApiFormat: ApiFormat | undefined
    fallbackApiFormat: ApiFormat
    onChange: (apiFormat: ApiFormat) => void
    showSingleOption?: boolean
}

/** Render a protocol picker for multiple formats, or a fixed value when explicitly requested. */
export function ApiFormatSelector({
    apiFormats,
    selectedApiFormat,
    fallbackApiFormat,
    onChange,
    showSingleOption = false,
}: ApiFormatSelectorProps) {
    const { t } = useUiTranslation()
    const inputId = useId()
    if (!apiFormats?.length || (apiFormats.length === 1 && !showSingleOption)) {
        return null
    }

    const selected = resolveApiFormat(selectedApiFormat, { apiFormats }, fallbackApiFormat)
    return (
        <ProfileField htmlFor={inputId} label={t("settings.ui.apiFormat")}>
            <select
                aria-label={t("settings.ui.apiFormat")}
                className="min-h-7 w-full rounded-xs border px-2 text-sm"
                disabled={apiFormats.length === 1}
                id={inputId}
                onChange={(event) => onChange(Number(event.target.value) as ApiFormat)}
                style={nativeSelectStyle}
                value={String(selected)}>
                {apiFormats.map((apiFormat) => (
                    <option key={apiFormat} style={nativeSelectOptionStyle} value={String(apiFormat)}>
                        {getApiFormatLabel(apiFormat)}
                    </option>
                ))}
            </select>
        </ProfileField>
    )
}
