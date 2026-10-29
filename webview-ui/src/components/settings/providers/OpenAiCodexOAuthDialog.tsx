import { type OpenAiCodexAuthFlow, OpenAiCodexBrowserOpenStatus } from "@shared/proto/dline/account"
import { StringRequest } from "@shared/proto/dline/common"
import { useEffect, useState } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FileServiceClient, WebServiceClient } from "@/services/grpc-client"
import { OpenAiCodexCredentialJsonImport } from "./OpenAiCodexCredentialJsonImport"
import type { OpenAiCodexOAuthDialogPhase } from "./useOpenAiCodexOAuthFlow"

interface OpenAiCodexOAuthDialogProps {
    open: boolean
    phase: OpenAiCodexOAuthDialogPhase
    flow?: OpenAiCodexAuthFlow
    busy: boolean
    error?: string
    onCancel: () => Promise<void>
    onComplete: (callbackUri: string) => Promise<void>
    onImport: (oauthJson: string) => Promise<void>
    onRestart: () => Promise<void>
    onTimedOut: () => void
}

function formatRemaining(expiresAtMs: number, nowMs: number): string {
    const totalSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
}

export function OpenAiCodexOAuthDialog({
    open,
    phase,
    flow,
    busy,
    error,
    onCancel,
    onComplete,
    onImport,
    onRestart,
    onTimedOut,
}: OpenAiCodexOAuthDialogProps) {
    const [callbackUri, setCallbackUri] = useState("")
    const [nowMs, setNowMs] = useState(Date.now())
    const [browserActionError, setBrowserActionError] = useState<string>()
    const timedOut = phase === "timed-out"
    const active = phase === "active" || phase === "completing"

    useEffect(() => {
        if (!open) {
            setCallbackUri("")
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
            setCallbackUri("")
            onTimedOut()
        }
    }, [active, flow, nowMs, onTimedOut])

    const complete = async () => {
        const submitted = callbackUri.trim()
        setCallbackUri("")
        if (!submitted) return
        await onComplete(submitted)
    }

    const cancel = async () => {
        setCallbackUri("")
        await onCancel()
    }

    const openInBrowser = async () => {
        if (!flow?.authorizationUrl) return
        setBrowserActionError(undefined)
        try {
            await WebServiceClient.openInBrowser(StringRequest.create({ value: flow.authorizationUrl }))
        } catch {
            setBrowserActionError("Could not open the browser. Copy the sign-in URL and open it manually.")
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
                    <DialogTitle>Sign in to ChatGPT</DialogTitle>
                    <DialogDescription>
                        {phase === "starting"
                            ? "Preparing a secure local callback…"
                            : timedOut
                              ? "This sign-in timed out. Start again."
                              : "Authorize in the browser. If it cannot return automatically, paste the full callback URL."}
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto border-y border-input-border/60 px-4 py-3">
                    <div className="flex flex-col gap-4">
                        {phase === "starting" ? <div className="text-sm">Generating the sign-in URL…</div> : null}
                        {phase === "failed" ? (
                            <div className="text-sm text-error-foreground">This sign-in failed. Try again.</div>
                        ) : null}
                        {flow ? (
                            <>
                                <div className="flex items-center justify-between gap-2 text-sm">
                                    <span>
                                        {timedOut
                                            ? "Sign-in timed out"
                                            : phase === "completing"
                                              ? "Completing sign-in…"
                                              : "Waiting for browser authorization"}
                                    </span>
                                    <span className="shrink-0 tabular-nums text-description">
                                        {timedOut ? "00:00" : `${formatRemaining(flow.expiresAtMs, nowMs)} left`}
                                    </span>
                                </div>

                                {!timedOut ? (
                                    <div className="flex flex-col gap-2">
                                        <label
                                            className="text-sm font-medium"
                                            htmlFor={`openai-codex-authorization-uri-${flow.profileId}`}>
                                            Sign-in URL
                                        </label>
                                        <div className="flex min-w-0 items-center gap-1">
                                            <input
                                                aria-label="ChatGPT sign-in URL"
                                                className="min-h-7 min-w-0 flex-1 truncate rounded-xs border border-input-border bg-input-background px-2 text-sm"
                                                id={`openai-codex-authorization-uri-${flow.profileId}`}
                                                readOnly
                                                value={flow.authorizationUrl}
                                            />
                                            <CopyButton
                                                ariaLabel="Copy sign-in URL"
                                                textToCopy={flow.authorizationUrl}
                                                writeText={(value) =>
                                                    FileServiceClient.copyToClipboard(StringRequest.create({ value }))
                                                }
                                            />
                                        </div>
                                        <button
                                            className="self-start text-sm text-link underline"
                                            onClick={() => void openInBrowser()}
                                            type="button">
                                            Open in browser again
                                        </button>
                                        {flow.browserOpenStatus ===
                                        OpenAiCodexBrowserOpenStatus.OPEN_AI_CODEX_BROWSER_OPEN_STATUS_FAILED ? (
                                            <div className="text-sm text-warning-foreground" role="status">
                                                The browser did not open automatically. Copy the sign-in URL and open it manually.
                                            </div>
                                        ) : null}
                                        {browserActionError ? (
                                            <div className="text-sm text-error-foreground" role="alert">
                                                {browserActionError}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}

                                <div className="flex flex-col gap-2">
                                    <label className="text-sm font-medium" htmlFor={`openai-codex-callback-${flow.profileId}`}>
                                        Paste the full callback URL
                                    </label>
                                    <textarea
                                        aria-label="Full callback URL"
                                        autoComplete="off"
                                        className="h-14 w-full resize-none overflow-y-auto rounded-xs border border-input-border bg-input-background p-2 text-sm"
                                        disabled={busy || timedOut}
                                        id={`openai-codex-callback-${flow.profileId}`}
                                        onChange={(event) => setCallbackUri(event.target.value)}
                                        placeholder="http://localhost:…/auth/callback?code=…&state=…"
                                        spellCheck={false}
                                        value={callbackUri}
                                    />
                                </div>

                                <OpenAiCodexCredentialJsonImport busy={busy} onImport={onImport} />
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
                        Cancel
                    </button>
                    <button
                        className="min-h-7 rounded-xs bg-button px-3 text-sm text-button-foreground disabled:opacity-50"
                        disabled={busy || (active && callbackUri.trim().length === 0)}
                        onClick={() => void (timedOut || phase === "failed" ? onRestart() : complete())}
                        type="button">
                        {timedOut || phase === "failed" ? "Try again" : "Finish sign-in"}
                    </button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
