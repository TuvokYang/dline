import { useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

interface OpenAiCodexCredentialJsonImportProps {
    busy: boolean
    onImport: (oauthJson: string) => Promise<void>
}

export function OpenAiCodexCredentialJsonImport({ busy, onImport }: OpenAiCodexCredentialJsonImportProps) {
    const { t } = useUiTranslation()
    const [open, setOpen] = useState(false)
    const [oauthJson, setOauthJson] = useState("")
    const [error, setError] = useState<"settings.ui.auth.pasteJson">()

    const importCredential = async () => {
        const submitted = oauthJson.trim()
        setOauthJson("")
        if (!submitted) {
            setError("settings.ui.auth.pasteJson")
            return
        }
        setError(undefined)
        await onImport(submitted)
    }

    return (
        <div className="rounded-xs border border-input-border/70 p-2">
            <button
                aria-expanded={open}
                className="w-full cursor-pointer text-left text-sm font-medium"
                onClick={() => {
                    const nextOpen = !open
                    setOpen(nextOpen)
                    if (!nextOpen) {
                        setOauthJson("")
                        setError(undefined)
                    }
                }}
                type="button">
                {open ? "▾" : "▸"} {t("settings.ui.auth.advancedImport")}
            </button>
            {open ? (
                <div className="mt-2 flex flex-col gap-2">
                    <p className="m-0 text-xs text-description">{t("settings.ui.auth.importHelp")}</p>
                    <textarea
                        aria-label="OpenAI Codex OAuth JSON"
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        className="h-24 max-h-24 w-full resize-none overflow-y-auto rounded-xs border border-input-border bg-input-background p-2 font-mono text-xs text-input-foreground"
                        onChange={(event) => setOauthJson(event.target.value)}
                        spellCheck={false}
                        value={oauthJson}
                    />
                    {error ? (
                        <div className="text-sm text-error-foreground" role="alert">
                            {t(error)}
                        </div>
                    ) : null}
                    <div className="flex justify-end">
                        <button
                            className="min-h-7 rounded-xs border border-button-border px-3 text-sm"
                            disabled={busy || oauthJson.trim().length === 0}
                            onClick={() => void importCredential()}
                            type="button">
                            {t("settings.ui.auth.importCredential")}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    )
}
