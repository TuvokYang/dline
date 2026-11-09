import { EmptyRequest } from "@shared/proto/dline/common"
import type { SupportStatus } from "@shared/proto/dline/support"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useState } from "react"
import type { UiTranslator } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { SupportServiceClient } from "@/services/grpc-client"

type SupportAction = "check" | "delete"
type SupportActionError = { action: SupportAction; diagnostic: string }

const actionErrorKeys = {
    check: "settings.ui.support.checkError",
    delete: "settings.ui.support.deleteError",
} as const

const stateLabels = (t: UiTranslator): Record<string, string> => ({
    awaiting_issue: t("settings.ui.support.awaitingIssue"),
    pending_approval: t("settings.ui.support.pendingApproval"),
    approved: t("settings.ui.support.approved"),
    revoked: t("settings.ui.support.revoked"),
    expired: t("settings.ui.support.expired"),
})
const issueStateLabels = (t: UiTranslator): Record<string, string> => ({
    unlinked: t("settings.ui.support.unlinked"),
    open: t("settings.ui.support.open"),
    closed: t("settings.ui.support.closed"),
})
const refreshReasonLabels = (t: UiTranslator): Record<string, string> => ({
    device_window: t("settings.ui.support.deviceWindow"),
    device_day: t("settings.ui.support.deviceDay"),
    global_query_day: t("settings.ui.support.globalDay"),
    query_ingress: t("settings.ui.support.ingress"),
    read_budget: t("settings.ui.support.readBudget"),
})
const resolutionLabels = (t: UiTranslator): Record<string, string> => ({
    none: t("settings.ui.support.noResolution"),
    investigating: t("settings.ui.support.investigating"),
    fixed: t("settings.ui.support.fixed"),
    wont_fix: t("settings.ui.support.wontFix"),
    duplicate: t("settings.ui.support.duplicate"),
    not_reproducible: t("settings.ui.support.notReproducible"),
})

function resolutionLabel(status: SupportStatus, t: UiTranslator): string {
    const resolution = status.resolution
    if (!resolution) return t("settings.ui.support.noResolution")
    const label = resolutionLabels(t)[resolution.state] ?? (resolution.state || t("settings.ui.unknown"))
    return resolution.fixedInVersion ? t("settings.ui.support.fixedIn", { label, version: resolution.fixedInVersion }) : label
}

/** Unknown service reasons remain raw diagnostics rather than guessed translations. */
function refreshMessage(state: string, reason: string | undefined, t: UiTranslator): string {
    const cause = reason ? refreshReasonLabels(t)[reason] : undefined
    return t("settings.ui.support.refresh", {
        lead: state === "stale" ? t("settings.ui.support.stale") : t("settings.ui.support.wait"),
        cause: cause ?? "",
    })
}

function formatCountdown(expiresAt: number | undefined, now: number, t: UiTranslator): string {
    if (!expiresAt) return t("settings.ui.support.unavailable")
    const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000))
    if (seconds === 0) return t("settings.ui.support.expired")
    return t("settings.ui.support.countdown", {
        hours: Math.floor(seconds / 3_600),
        minutes: Math.floor((seconds % 3_600) / 60),
        seconds: seconds % 60,
    })
}

function StatusRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
    return (
        <div className="flex items-start justify-between gap-3 border-b border-vscode-widget-border py-1.5 last:border-b-0">
            <span className="shrink-0 text-xs text-description">{label}</span>
            <span className="break-all text-right text-xs" data-testid={testId}>
                {value}
            </span>
        </div>
    )
}

/** Safe Settings projection for a user-confirmed temporary support authorization. */
export function SupportTelemetryStatus() {
    const { t } = useUiTranslation()
    const [status, setStatus] = useState<SupportStatus>()
    const [loaded, setLoaded] = useState(false)
    const [now, setNow] = useState(Date.now())
    const [busy, setBusy] = useState<SupportAction>()
    const [error, setError] = useState<SupportActionError>()
    const [deleteArmed, setDeleteArmed] = useState(false)

    const readStatus = useCallback(async () => {
        const next = await SupportServiceClient.getStatus(EmptyRequest.create({}))
        setStatus(next)
    }, [])

    useEffect(() => {
        let mounted = true
        void SupportServiceClient.getStatus(EmptyRequest.create({}))
            .then((next) => {
                if (mounted) setStatus(next)
            })
            .catch((cause) => {
                if (mounted) setError({ action: "check", diagnostic: cause instanceof Error ? cause.message : String(cause) })
            })
            .finally(() => {
                if (mounted) setLoaded(true)
            })
        return () => {
            mounted = false
        }
    }, [])

    useEffect(() => {
        if (!status?.present) return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1_000)
        return () => clearInterval(timer)
    }, [status?.present])

    const run = async (action: SupportAction, operation: () => Promise<void>) => {
        setBusy(action)
        setError(undefined)
        try {
            await operation()
        } catch (cause) {
            setError({ action, diagnostic: cause instanceof Error ? cause.message : String(cause) })
        } finally {
            setBusy(undefined)
        }
    }

    const checkNow = () =>
        run("check", async () => {
            const next = await SupportServiceClient.checkNow(EmptyRequest.create({}))
            setStatus(next)
            setNow(Date.now())
        })

    const deleteAndRevoke = () =>
        run("delete", async () => {
            await SupportServiceClient.deleteAndRevoke(EmptyRequest.create({}))
            setDeleteArmed(false)
            await readStatus()
        })

    if (!loaded || !status?.present) return null

    const stateLabel = stateLabels(t)[status.state] ?? (status.state || t("settings.ui.unknown"))
    const issueLabel = issueStateLabels(t)[status.issueState] ?? (status.issueState || t("settings.ui.unknown"))
    const summary = status.resolution?.summary
    const refresh = status.refresh

    return (
        <div data-testid="support-telemetry-status">
            <h3 className="text-md font-semibold">{t("settings.ui.support.title")}</h3>
            <p className="text-sm text-description">{t("settings.ui.support.help")}</p>
            <div className="mt-2 rounded bg-vscode-textBlockQuote-background p-3">
                <StatusRow label={t("settings.ui.support.publicCode")} testId="support-public-code" value={status.publicCode} />
                <StatusRow label={t("settings.ui.support.securityStatus")} testId="support-state" value={stateLabel} />
                <StatusRow label={t("settings.ui.support.issue")} testId="support-issue" value={issueLabel} />
                <StatusRow
                    label={t("settings.ui.support.resolution")}
                    testId="support-resolution"
                    value={resolutionLabel(status, t)}
                />
                {summary && (
                    <StatusRow label={t("settings.ui.support.note")} testId="support-resolution-summary" value={summary} />
                )}
                <StatusRow
                    label={t("settings.ui.support.authorizationRemaining")}
                    testId="support-authorization-countdown"
                    value={formatCountdown(status.authorizationExpiresAt, now, t)}
                />
                <StatusRow
                    label={t("settings.ui.support.captureRemaining")}
                    testId="support-capture-countdown"
                    value={formatCountdown(status.captureExpiresAt, now, t)}
                />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
                <VSCodeButton appearance="secondary" disabled={busy !== undefined} onClick={checkNow}>
                    {busy === "check" ? t("settings.ui.support.checking") : t("settings.ui.support.checkNow")}
                </VSCodeButton>
                {!deleteArmed ? (
                    <VSCodeButton appearance="secondary" disabled={busy !== undefined} onClick={() => setDeleteArmed(true)}>
                        {t("settings.ui.support.delete")}
                    </VSCodeButton>
                ) : (
                    <>
                        <VSCodeButton appearance="secondary" disabled={busy !== undefined} onClick={deleteAndRevoke}>
                            {busy === "delete" ? t("settings.ui.support.deleting") : t("settings.ui.support.confirmDelete")}
                        </VSCodeButton>
                        <VSCodeButton appearance="secondary" disabled={busy !== undefined} onClick={() => setDeleteArmed(false)}>
                            {t("settings.ui.cancel")}
                        </VSCodeButton>
                    </>
                )}
            </div>
            {deleteArmed && <p className="mt-[5px] text-sm text-description">{t("settings.ui.support.deleteHelp")}</p>}
            {refresh && (
                <p className="mt-[5px] text-sm text-description" data-testid="support-telemetry-refresh">
                    {refreshMessage(refresh.state, refresh.reason, t)}
                    {refresh.nextQueryAt ? (
                        <> {t("settings.ui.support.nextQuery", { time: formatCountdown(refresh.nextQueryAt, now, t) })}</>
                    ) : null}
                </p>
            )}
            {error && (
                <p className="mt-[5px] text-sm text-error" data-testid="support-telemetry-error">
                    {t(actionErrorKeys[error.action], { diagnostic: error.diagnostic })}
                </p>
            )}
        </div>
    )
}
