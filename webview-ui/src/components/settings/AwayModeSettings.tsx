import { useState } from "react"
import { Switch } from "@/components/ui/switch"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

export type AwaySettingKey = "awayModeEnabled" | "autoAwayModeEnabled"

export interface AwayModeSettingsProps {
    gateEnabled: boolean
    enabled: boolean
    automatic: boolean
    onChange: (key: AwaySettingKey, value: boolean) => Promise<unknown>
}

/** Controlled global preferences; only the backend owns their committed values. */
export default function AwayModeSettings({ gateEnabled, enabled, automatic, onChange }: AwayModeSettingsProps) {
    const { t } = useUiTranslation()
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<{ diagnostic?: string }>()
    if (!gateEnabled) return null

    const change = async (key: AwaySettingKey, value: boolean) => {
        setPending(true)
        setError(undefined)
        try {
            await onChange(key, value)
        } catch (cause) {
            setError({ diagnostic: cause instanceof Error ? cause.message : undefined })
        } finally {
            setPending(false)
        }
    }
    return (
        <fieldset aria-busy={pending} className="space-y-3 py-3">
            <legend className="text-sm font-medium">{t("settings.ui.away.title")}</legend>
            <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                    <label htmlFor="away-mode-enabled">{t("settings.ui.away.enable")}</label>
                    <Switch
                        aria-label={t("settings.ui.away.enable")}
                        checked={enabled}
                        disabled={pending}
                        id="away-mode-enabled"
                        onCheckedChange={(value) => void change("awayModeEnabled", value)}
                        size="lg"
                    />
                </div>
                <p className="text-xs text-description">{t("settings.ui.away.help")}</p>
            </div>
            <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                    <label htmlFor="auto-away-mode-enabled">{t("settings.ui.away.automatic")}</label>
                    <Switch
                        aria-label={t("settings.ui.away.automatic")}
                        checked={automatic}
                        disabled={!enabled || pending}
                        id="auto-away-mode-enabled"
                        onCheckedChange={(value) => void change("autoAwayModeEnabled", value)}
                        size="lg"
                    />
                </div>
                <p className="text-xs text-description">{t("settings.ui.away.automaticHelp")}</p>
            </div>
            {error ? (
                <div className="text-xs text-(--vscode-errorForeground)" role="alert">
                    {t("settings.ui.away.saveError")}
                    {error.diagnostic ? <div>{error.diagnostic}</div> : null}
                </div>
            ) : null}
        </fieldset>
    )
}
