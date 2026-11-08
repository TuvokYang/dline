import { AUTO_LANGUAGE_PREFERENCE, getLanguageKey, languageOptions } from "@shared/Languages"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import React from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ProfileField } from "./profile-ui"
import { updateSetting } from "./utils/settingsHandlers"

const PreferredLanguageSetting: React.FC = () => {
    const { preferredLanguage } = useExtensionState()
    const { t } = useUiTranslation()
    const value = preferredLanguage || "English"
    const selectedLabel =
        value === AUTO_LANGUAGE_PREFERENCE
            ? t("settings.general.preferredLanguage.auto")
            : t(`settings.general.preferredLanguage.option.${getLanguageKey(value)}`)

    const handleLanguageChange = (newLanguage: string) => {
        updateSetting("preferredLanguage", newLanguage)
    }

    return (
        <ProfileField
            description={<span id="preferred-language-description">{t("settings.general.preferredLanguage.description")}</span>}
            htmlFor="preferred-language-dropdown"
            label={t("settings.general.preferredLanguage.label")}>
            <VSCodeDropdown
                aria-describedby="preferred-language-description"
                aria-label={t("settings.general.preferredLanguage.label")}
                id="preferred-language-dropdown"
                onChange={(event) => {
                    handleLanguageChange((event.target as HTMLSelectElement).value)
                }}
                style={{ width: "100%" }}
                value={value}>
                <span slot="selected-value">{selectedLabel}</span>
                <VSCodeOption aria-label={t("settings.general.preferredLanguage.auto")} value={AUTO_LANGUAGE_PREFERENCE}>
                    {t("settings.general.preferredLanguage.auto")}
                </VSCodeOption>
                {languageOptions.map(({ key, display }) => (
                    <VSCodeOption aria-label={t(`settings.general.preferredLanguage.option.${key}`)} key={key} value={display}>
                        {t(`settings.general.preferredLanguage.option.${key}`)}
                    </VSCodeOption>
                ))}
            </VSCodeDropdown>
        </ProfileField>
    )
}

export default React.memo(PreferredLanguageSetting)
