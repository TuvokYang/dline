import { useEffect, useState } from "react"
import type { HydrationFailureReason } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

/**
 * What the user sees while the webview has no state to render yet.
 *
 * The panel used to render nothing at all in this window, which is
 * indistinguishable from a broken extension: no text, no spinner, no way to
 * tell whether waiting longer would help. These components replace that blank
 * with something that says which of the two is happening.
 */

/** How long a normal hydration is expected to take before it warrants concern. */
const SLOW_HYDRATION_THRESHOLD_MS = 5000

interface HydrationPendingProps {
    /** Overridable so tests do not have to wait out the real threshold. */
    slowThresholdMs?: number
}

/**
 * Shown while the first state payload is still in flight.
 *
 * After the threshold the copy escalates rather than replacing the view: a
 * hydration that is merely slow and one that will never finish look the same
 * from here, and claiming failure prematurely would be its own defect.
 */
export const HydrationPending = ({ slowThresholdMs = SLOW_HYDRATION_THRESHOLD_MS }: HydrationPendingProps) => {
    const { t } = useUiTranslation()
    const [isSlow, setIsSlow] = useState(false)

    useEffect(() => {
        const timer = setTimeout(() => setIsSlow(true), slowThresholdMs)
        return () => clearTimeout(timer)
    }, [slowThresholdMs])

    return (
        <div
            className="flex h-screen w-full flex-col items-center justify-center gap-2 p-4 text-center"
            data-testid="hydration-pending">
            <div className="text-[var(--vscode-descriptionForeground)]">{t("shell.hydration.pending")}</div>
            {isSlow && (
                <div className="text-sm text-[var(--vscode-descriptionForeground)]" data-testid="hydration-pending-slow">
                    {t("shell.hydration.slow")}
                </div>
            )}
        </div>
    )
}

interface HydrationFailedProps {
    /** Stream diagnostics stay verbatim; product fallbacks are translated at render. */
    reason: HydrationFailureReason
    onRetry: () => void
}

/**
 * Shown when the state stream failed or closed without delivering state.
 *
 * The reason is surfaced rather than logged to the console alone: a user
 * reporting a blank panel cannot be asked to open developer tools, and the
 * console message was the only trace this failure previously left.
 */
export const HydrationFailed = ({ reason, onRetry }: HydrationFailedProps) => {
    const { t } = useUiTranslation()

    return (
        <div
            className="flex h-screen w-full flex-col items-center justify-center gap-3 p-4 text-center"
            data-testid="hydration-failed">
            <div className="text-[var(--vscode-errorForeground)]">{t("shell.hydration.failed")}</div>
            <div className="text-sm text-[var(--vscode-descriptionForeground)]" data-testid="hydration-failed-reason">
                {typeof reason === "string"
                    ? reason
                    : reason.kind === "closed"
                      ? t("runtime.hydration.closed")
                      : t("runtime.hydration.unknown")}
            </div>
            <button
                className="cursor-pointer rounded border border-[var(--vscode-button-border)] bg-[var(--vscode-button-background)] px-3 py-1 text-[var(--vscode-button-foreground)]"
                data-testid="hydration-retry"
                onClick={onRetry}
                type="button">
                {t("shell.chrome.retry")}
            </button>
        </div>
    )
}
