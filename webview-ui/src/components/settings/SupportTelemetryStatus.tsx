import { EmptyRequest } from "@shared/proto/dline/common"
import type { SupportStatus } from "@shared/proto/dline/support"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useState } from "react"
import { SupportServiceClient } from "@/services/grpc-client"

type SupportAction = "check" | "delete"

const STATE_LABELS: Record<string, string> = {
    awaiting_issue: "Waiting for the GitHub issue",
    pending_approval: "Waiting for support approval",
    approved: "Approved and capturing temporary diagnostics",
    revoked: "Revoked",
    expired: "Expired",
}

const ISSUE_STATE_LABELS: Record<string, string> = {
    unlinked: "Not linked yet",
    open: "Open",
    closed: "Closed",
}

const RESOLUTION_LABELS: Record<string, string> = {
    none: "No resolution yet",
    investigating: "Investigating",
    fixed: "Fixed",
    wont_fix: "Won't fix",
    duplicate: "Duplicate",
    not_reproducible: "Not reproducible",
}

function resolutionLabel(status: SupportStatus): string {
    const resolution = status.resolution
    if (!resolution) return RESOLUTION_LABELS.none
    const label = RESOLUTION_LABELS[resolution.state] ?? (resolution.state || "Unknown")
    return resolution.fixedInVersion ? `${label} in ${resolution.fixedInVersion}` : label
}

function formatCountdown(expiresAt: number | undefined, now: number): string {
    if (!expiresAt) return "Not available"
    const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000))
    if (seconds === 0) return "Expired"
    const hours = Math.floor(seconds / 3_600)
    const minutes = Math.floor((seconds % 3_600) / 60)
    const remainder = seconds % 60
    if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`
    if (minutes > 0) return `${minutes}m ${remainder}s`
    return `${remainder}s`
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
    const [status, setStatus] = useState<SupportStatus>()
    const [loaded, setLoaded] = useState(false)
    const [now, setNow] = useState(Date.now())
    const [busy, setBusy] = useState<SupportAction>()
    const [error, setError] = useState<string>()
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
                if (mounted) setError(cause instanceof Error ? cause.message : String(cause))
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
            setError(cause instanceof Error ? cause.message : String(cause))
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

    const stateLabel = STATE_LABELS[status.state] ?? (status.state || "Unknown")
    const issueLabel = ISSUE_STATE_LABELS[status.issueState] ?? (status.issueState || "Unknown")
    const summary = status.resolution?.summary

    return (
        <div data-testid="support-telemetry-status">
            <h3 className="text-md font-semibold">Temporary support telemetry</h3>
            <p className="text-sm text-description">
                This authorization exists only because temporary telemetry was explicitly confirmed in a bug report. Private
                credentials remain in owner-only local storage and are never shown here.
            </p>
            <div className="mt-2 rounded bg-vscode-textBlockQuote-background p-3">
                <StatusRow label="Public support code" testId="support-public-code" value={status.publicCode} />
                <StatusRow label="Security status" testId="support-state" value={stateLabel} />
                <StatusRow label="GitHub issue" testId="support-issue" value={issueLabel} />
                <StatusRow label="Resolution" testId="support-resolution" value={resolutionLabel(status)} />
                {summary && <StatusRow label="Maintainer note" testId="support-resolution-summary" value={summary} />}
                <StatusRow
                    label="Authorization remaining"
                    testId="support-authorization-countdown"
                    value={formatCountdown(status.authorizationExpiresAt, now)}
                />
                <StatusRow
                    label="Capture remaining"
                    testId="support-capture-countdown"
                    value={formatCountdown(status.captureExpiresAt, now)}
                />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
                <VSCodeButton appearance="secondary" disabled={busy !== undefined} onClick={checkNow}>
                    {busy === "check" ? "Checking…" : "Check now"}
                </VSCodeButton>
                {!deleteArmed ? (
                    <VSCodeButton appearance="secondary" disabled={busy !== undefined} onClick={() => setDeleteArmed(true)}>
                        Delete & Revoke
                    </VSCodeButton>
                ) : (
                    <>
                        <VSCodeButton appearance="secondary" disabled={busy !== undefined} onClick={deleteAndRevoke}>
                            {busy === "delete" ? "Deleting…" : "Confirm delete & revoke"}
                        </VSCodeButton>
                        <VSCodeButton appearance="secondary" disabled={busy !== undefined} onClick={() => setDeleteArmed(false)}>
                            Cancel
                        </VSCodeButton>
                    </>
                )}
            </div>
            {deleteArmed && (
                <p className="mt-[5px] text-sm text-description">
                    Dline will stop local capture, clear issue-only access and delete the local authorization. Nothing is sent to
                    the service or the issue; the server ends the authorization when the issue closes or it expires.
                </p>
            )}
            {error && (
                <p className="mt-[5px] text-sm text-error" data-testid="support-telemetry-error">
                    {error}
                </p>
            )}
        </div>
    )
}
