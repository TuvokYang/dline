import { type ClaudeCodeAuthFlow, OpenAiCodexBrowserOpenStatus } from "@shared/proto/dline/account"
import { StringRequest } from "@shared/proto/dline/common"
import { useEffect, useState } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { FileServiceClient, WebServiceClient } from "@/services/grpc-client"
import type { ClaudeCodeOAuthDialogPhase } from "./useClaudeCodeOAuthFlow"

interface ClaudeCodeOAuthDialogProps {
    open: boolean
    phase: ClaudeCodeOAuthDialogPhase
    flow?: ClaudeCodeAuthFlow
    busy: boolean
    error?: string
    onCancel: () => Promise<void>
    onComplete: (pastedValue: string) => Promise<void>
    onRestart: () => Promise<void>
    onTimedOut: () => void
}

function formatRemaining(expiresAtMs: number, nowMs: number): string {
    const totalSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
}

/**
 * Claude Code sign-in dialog.
 *
 * One paste field accepts either the callback URL or the `code#state` string
 * from Anthropic's hosted page; the backend decides which form it received, so
 * the user never selects a mode.
 */
export function ClaudeCodeOAuthDialog({
    open,
    phase,
    flow,
    busy,
    error,
    onCancel,
    onComplete,
    onRestart,
    onTimedOut,
}: ClaudeCodeOAuthDialogProps) {
    const { t } = useUiTranslation()
    const [pastedValue, setPastedValue] = useState("")
    const [nowMs, setNowMs] = useState(Date.now())
    const [browserActionError, setBrowserActionError] = useState<"settings.ui.auth.browserError">()
    const timedOut = phase === "timed-out"
    const active = phase === "active" || phase === "completing"

    useEffect(() => {
        if (!open) {
            setPastedValue("")
            setBrowserActionError(undefined)
        }
    }, [open])

    useEffect(() => {
        if (!open || !active || !flow) return
        setNowMs(Date.now())
        const timer = setInterval(() => setNowMs(Date.now()), 1_000)
        return () => clearInterval(timer)
    }, [active, flow, open])

    useEffect(() => {
        if (active && flow && nowMs >= flow.expiresAtMs) {
            setPastedValue("")
            onTimedOut()
        }
    }, [active, flow, nowMs, onTimedOut])

    const complete = async () => {
        const submitted = pastedValue.trim()
        setPastedValue("")
        if (!submitted) return
        await onComplete(submitted)
    }

    const cancel = async () => {
        setPastedValue("")
        await onCancel()
    }

    const openInBrowser = async (url: string) => {
        setBrowserActionError(undefined)
        try {
            await WebServiceClient.openInBrowser(StringRequest.create({ value: url }))
        } catch {
            setBrowserActionError("settings.ui.auth.browserError")
        }
    }

    return (
        <Dialog
            onOpenChange={(nextOpen) => {
                if (!nextOpen && open && !busy) void cancel()
            }}
            open={open}>
            <DialogContent
                className="!top-1/2 flex max-h-[calc(100vh-2rem)] w-[calc(100%-1.5rem)] max-w-[440px] !translate-y-[-50%] flex-col gap-0 p-0"
                onInteractOutside={(event) => event.preventDefault()}>
                <DialogHeader className="shrink-0 px-4 pb-3 pt-4 pr-10 text-left">
                    <DialogTitle>{t("settings.ui.auth.dialogTitle", { provider: "Claude" })}</DialogTitle>
                    <DialogDescription>
                        {phase === "starting"
                            ? t("settings.ui.auth.preparing")
                            : timedOut
                              ? t("settings.ui.auth.timeoutHelp")
                              : t("settings.ui.auth.claudeAuthorize")}
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto border-y border-input-border/60 px-4 py-3">
                    <div className="flex flex-col gap-4">
                        {phase === "starting" ? <div className="text-sm">{t("settings.ui.auth.generating")}</div> : null}
                        {phase === "failed" && !flow ? (
                            <div className="text-sm text-error-foreground">{t("settings.ui.auth.failedHelp")}</div>
                        ) : null}
                        {flow ? (
                            <>
                                <div className="flex items-center justify-between gap-2 text-sm">
                                    <span>
                                        {timedOut
                                            ? t("settings.ui.auth.timedOut")
                                            : phase === "completing"
                                              ? t("settings.ui.auth.completing")
                                              : t("settings.ui.auth.waiting")}
                                    </span>
                                    <span className="shrink-0 tabular-nums text-description">
                                        {timedOut
                                            ? "00:00"
                                            : t("settings.ui.auth.timeLeft", { time: formatRemaining(flow.expiresAtMs, nowMs) })}
                                    </span>
                                </div>

                                {!timedOut ? (
                                    <div className="flex flex-col gap-2">
                                        <label
                                            className="text-sm font-medium"
                                            htmlFor={`claude-code-authorization-uri-${flow.profileId}`}>
                                            {t("settings.ui.auth.url")}
                                        </label>
                                        <div className="flex min-w-0 items-center gap-1">
                                            <input
                                                aria-label={t("settings.ui.auth.providerUrl", { provider: "Claude" })}
                                                className="min-h-7 min-w-0 flex-1 truncate rounded-xs border border-input-border bg-input-background px-2 text-sm"
                                                id={`claude-code-authorization-uri-${flow.profileId}`}
                                                readOnly
                                                value={flow.authorizationUrl}
                                            />
                                            <CopyButton
                                                ariaLabel={t("settings.ui.auth.copyUrl")}
                                                textToCopy={flow.authorizationUrl}
                                                writeText={(value) =>
                                                    FileServiceClient.copyToClipboard(StringRequest.create({ value }))
                                                }
                                            />
                                        </div>
                                        <button
                                            className="self-start text-sm text-link underline"
                                            onClick={() => void openInBrowser(flow.authorizationUrl)}
                                            type="button">
                                            {t("settings.ui.auth.openBrowser")}
                                        </button>
                                        {!flow.loopbackListening ? (
                                            <div className="text-sm text-warning-foreground" role="status">
                                                {t("settings.ui.auth.noCallback")}
                                            </div>
                                        ) : flow.manualAuthorizationUrl ? (
                                            <button
                                                className="self-start text-sm text-link underline"
                                                onClick={() => void openInBrowser(flow.manualAuthorizationUrl as string)}
                                                type="button">
                                                {t("settings.ui.auth.codePage")}
                                            </button>
                                        ) : null}
                                        {flow.browserOpenStatus ===
                                        OpenAiCodexBrowserOpenStatus.OPEN_AI_CODEX_BROWSER_OPEN_STATUS_FAILED ? (
                                            <div className="text-sm text-warning-foreground" role="status">
                                                {t("settings.ui.auth.browserNotOpened")}
                                            </div>
                                        ) : null}
                                        {browserActionError ? (
                                            <div className="text-sm text-error-foreground" role="alert">
                                                {t(browserActionError)}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}

                                <div className="flex flex-col gap-2">
                                    <label className="text-sm font-medium" htmlFor={`claude-code-callback-${flow.profileId}`}>
                                        {t("settings.ui.auth.pasteCode")}
                                    </label>
                                    <textarea
                                        aria-label={t("settings.ui.auth.callbackCode")}
                                        autoComplete="off"
                                        className="h-14 w-full resize-none overflow-y-auto rounded-xs border border-input-border bg-input-background p-2 text-sm"
                                        disabled={busy || timedOut}
                                        id={`claude-code-callback-${flow.profileId}`}
                                        onChange={(event) => setPastedValue(event.target.value)}
                                        placeholder={t("settings.ui.auth.codePlaceholder")}
                                        spellCheck={false}
                                        value={pastedValue}
                                    />
                                    <p className="text-xs text-description">{t("settings.ui.auth.codeHelp")}</p>
                                </div>
                            </>
                        ) : null}
                        {error ? (
                            <div className="text-sm text-error-foreground" role="alert">
                                {error}
                            </div>
                        ) : null}
                    </div>
                </div>

                <DialogFooter className="shrink-0 flex-row justify-end gap-2 px-4 py-3 sm:space-x-0">
                    <button
                        className="min-h-7 rounded-xs border border-button-border px-3 text-sm"
                        disabled={busy}
                        onClick={() => void cancel()}
                        type="button">
                        {t("settings.ui.cancel")}
                    </button>
                    <button
                        className="min-h-7 rounded-xs bg-button px-3 text-sm text-button-foreground disabled:opacity-50"
                        disabled={busy || (active && pastedValue.trim().length === 0)}
                        onClick={() => void (timedOut || phase === "failed" ? onRestart() : complete())}
                        type="button">
                        {timedOut || phase === "failed" ? t("settings.ui.auth.tryAgain") : t("settings.ui.auth.finish")}
                    </button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
