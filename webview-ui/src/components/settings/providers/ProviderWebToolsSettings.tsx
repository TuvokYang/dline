import type { WebToolsMode } from "@shared/proto/dline/provider/common"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { WebToolsModeControl } from "./WebToolsModeControl"

interface ProviderWebToolsSettingsProps {
    value?: WebToolsMode
    onChange: (value: WebToolsMode) => void
    hostedAvailable: boolean
}

/** Display one provider-owned Web Tools routing control and its current hosted availability. */
export function ProviderWebToolsSettings({ value, onChange, hostedAvailable }: ProviderWebToolsSettingsProps) {
    const { t } = useUiTranslation()
    return (
        <div className="mb-2">
            <WebToolsModeControl onChange={onChange} value={value} />
            <p className="m-0 text-xs text-description">
                {hostedAvailable ? t("settings.ui.web.hostedAvailable") : t("settings.ui.web.hostedUnavailable")}
            </p>
        </div>
    )
}
