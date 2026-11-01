import { useState } from "react"
import { Switch } from "@/components/ui/switch"

export type AwaySettingKey = "awayModeEnabled" | "autoAwayModeEnabled"

export interface AwayModeSettingsProps {
    gateEnabled: boolean
    enabled: boolean
    automatic: boolean
    onChange: (key: AwaySettingKey, value: boolean) => Promise<unknown>
}

/** Controlled global preferences; only the backend owns their committed values. */
export default function AwayModeSettings({ gateEnabled, enabled, automatic, onChange }: AwayModeSettingsProps) {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string>()
    if (!gateEnabled) return null

    const change = async (key: AwaySettingKey, value: boolean) => {
        setPending(true)
        setError(undefined)
        try {
            await onChange(key, value)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The Away Mode setting could not be saved. Try again.")
        } finally {
            setPending(false)
        }
    }
    return (
        <fieldset aria-busy={pending} className="space-y-3 py-3">
            <legend className="text-sm font-medium">Away Mode</legend>
            <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                    <label htmlFor="away-mode-enabled">Enable Away Mode</label>
                    <Switch
                        aria-label="Enable Away Mode"
                        checked={enabled}
                        disabled={pending}
                        id="away-mode-enabled"
                        onCheckedChange={(value) => void change("awayModeEnabled", value)}
                        size="lg"
                    />
                </div>
                <p className="text-xs text-description">
                    Allow /away with a task message to keep the current task working while you are away. Turning this off also
                    exits active Away Mode.
                </p>
            </div>
            <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                    <label htmlFor="auto-away-mode-enabled">Automatic Away Mode</label>
                    <Switch
                        aria-label="Automatic Away Mode"
                        checked={automatic}
                        disabled={!enabled || pending}
                        id="auto-away-mode-enabled"
                        onCheckedChange={(value) => void change("autoAwayModeEnabled", value)}
                        size="lg"
                    />
                </div>
                <p className="text-xs text-description">
                    Enter Away Mode when a new question goes unanswered for ten minutes. This does not apply to questions already
                    waiting when enabled.
                </p>
            </div>
            {error ? (
                <div className="text-xs text-(--vscode-errorForeground)" role="alert">
                    {error}
                </div>
            ) : null}
        </fieldset>
    )
}
