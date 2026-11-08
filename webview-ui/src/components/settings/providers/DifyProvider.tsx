// Mode import removed — no longer needed in profile-driven architecture
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import type { ApiProfile } from "./ProviderProfile"

interface DifyProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/** Dify provider �?all data from ApiProfile. baseUrl used for Dify instance URL. */
export const DifyProvider = ({
    showModelOptions: _showModelOptions,
    isPopup: _isPopup,
    profile,
    onUpdate,
}: DifyProviderProps) => {
    const { t } = useUiTranslation()
    return (
        <div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <DebouncedTextField
                    initialValue={profile.baseUrl || ""}
                    onChange={(value) => onUpdate({ baseUrl: value })}
                    placeholder={t("settings.ui.enterBaseUrl")}
                    style={{ width: "100%", marginBottom: 10 }}
                    type="text">
                    <span style={{ fontWeight: 500 }}>{t("settings.ui.baseUrl")}</span>
                </DebouncedTextField>
                <ApiKeyField
                    initialValue={profile.apiKey}
                    onChange={(value) => onUpdate({ apiKey: value })}
                    providerName="Dify"
                />
                <div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "5px" }}>
                    <p>{t("settings.ui.dify.help")}</p>
                    <p style={{ marginTop: "8px" }}>
                        <strong>{t("settings.ui.note")}</strong> {t("settings.ui.dify.modelHelp")}
                    </p>
                </div>
            </div>
        </div>
    )
}
