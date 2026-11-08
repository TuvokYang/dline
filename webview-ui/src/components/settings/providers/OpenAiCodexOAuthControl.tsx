import { OpenAiCodexAuthStatus } from "@shared/proto/dline/account"
import { CheckCircle2Icon, CircleDashedIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react"
import { type ReactNode, useEffect } from "react"
import type { UiTranslator } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ProfileActionRow, ProfileNotice, ProfileSection } from "../profile-ui"
import { OpenAiCodexOAuthDialog } from "./OpenAiCodexOAuthDialog"
import { OpenAiCodexUsage } from "./OpenAiCodexUsage"
import { isOpenAiCodexAuthenticated, useOpenAiCodexOAuthFlow } from "./useOpenAiCodexOAuthFlow"

/**
 * Native buttons keep the control keyboard and screen-reader accessible.
 *
 * The toolkit's `<vscode-button>` custom element does not expose a button role outside a browser
 * runtime, so it cannot be targeted by role in tests or by assistive technology in the webview.
 */
const BUTTON_BASE_CLASS =
    "min-h-7 cursor-pointer rounded-xs border px-3 text-sm font-medium shadow-sm transition-colors disabled:cursor-default disabled:opacity-50"
const PRIMARY_BUTTON_CLASS = `${BUTTON_BASE_CLASS} border-button-background bg-button-background text-button-foreground hover:bg-button-background-hover disabled:hover:bg-button-background`
const DANGER_BUTTON_CLASS = `${BUTTON_BASE_CLASS} border-error/70 bg-error/15 text-error hover:bg-error/25 disabled:hover:bg-error/15`

/**
 * Severity of an authentication state.
 *
 * `normal` states are expected outcomes and stay inline so they do not compete with the sign-in
 * action. `attention` states require the user to act and are promoted to a full notice.
 */
type StatusSeverity = "normal" | "attention"

interface StatusPresentation {
    label: string
    severity: StatusSeverity
    /** Shown only for attention states, where the user needs to know what to do next. */
    guidance?: string
}

function statusPresentation(status: OpenAiCodexAuthStatus, t: UiTranslator): StatusPresentation {
    switch (status) {
        case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED:
            return { label: t("settings.ui.auth.signedIn"), severity: "normal" }
        case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_REFRESHABLE_EXPIRED:
            return { label: t("settings.ui.auth.refreshing"), severity: "normal" }
        case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_LEGACY_SHARED:
            return {
                label: t("settings.ui.auth.required"),
                severity: "attention",
                guidance: t("settings.ui.auth.profileHelp"),
            }
        case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MALFORMED:
            return {
                label: t("settings.ui.auth.invalid"),
                severity: "attention",
                guidance: t("settings.ui.auth.invalidHelp"),
            }
        case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_REAUTHENTICATION_REQUIRED:
            return {
                label: t("settings.ui.auth.expired"),
                severity: "attention",
                guidance: t("settings.ui.auth.expiredHelp"),
            }
        case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MISSING:
            return { label: t("settings.ui.auth.notSignedIn"), severity: "normal" }
        default:
            return { label: t("settings.ui.auth.checking"), severity: "normal" }
    }
}

function accountTypeLabel(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase()
    if (!normalized || normalized === "unknown") return undefined
    return (
        {
            free: "Free",
            plus: "Plus",
            pro: "Pro",
            team: "Team",
            business: "Business",
            enterprise: "Enterprise",
            edu: "Edu",
        }[normalized] ?? value?.trim()
    )
}

function formatAccountExpiry(expiresAtMs: number | undefined): string | undefined {
    if (expiresAtMs === undefined) return undefined
    const date = new Date(expiresAtMs)
    return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()
}

function statusIcon(status: OpenAiCodexAuthStatus, severity: StatusSeverity, checking: boolean): ReactNode {
    if (checking) return <LoaderIcon className="size-3.5 animate-spin" />
    if (severity === "attention") return <TriangleAlertIcon className="size-3.5 text-editor-warning-foreground" />
    if (isOpenAiCodexAuthenticated(status)) return <CheckCircle2Icon className="size-3.5 text-success" />
    return <CircleDashedIcon className="size-3.5" />
}

export function OpenAiCodexOAuthControl({
    profileId,
    onAuthenticatedChange,
}: {
    profileId: string
    onAuthenticatedChange?: (authenticated: boolean) => void
}) {
    const { t } = useUiTranslation()
    const flow = useOpenAiCodexOAuthFlow(profileId)
    const authenticated = isOpenAiCodexAuthenticated(flow.status)
    const presentation = statusPresentation(flow.status, t)
    const inProgress = flow.dialog.phase === "starting" || flow.dialog.phase === "active" || flow.dialog.phase === "completing"
    const checking = !inProgress && flow.status === OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_UNSPECIFIED
    const label = inProgress ? t("settings.ui.auth.signingIn") : presentation.label
    const actionsDisabled = flow.busy || inProgress
    const blockingError = flow.statusError ?? (flow.dialog.phase === "closed" ? flow.actionError : undefined)
    const accountName = flow.account?.displayName?.trim()
    const accountEmail = flow.account?.email?.trim()
    const accountType = accountTypeLabel(flow.account?.accountType)
    const accountExpiry = formatAccountExpiry(flow.account?.expiresAtMs)

    useEffect(() => {
        onAuthenticatedChange?.(authenticated)
    }, [authenticated, onAuthenticatedChange])

    return (
        <ProfileSection aria-label={t("settings.ui.auth.account", { provider: "ChatGPT" })}>
            <div className="min-w-0 rounded-xs border border-editor-widget-border/60 bg-toolbar-hover/20 p-2">
                <ProfileActionRow className="justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-description">
                        <span aria-hidden="true" className="flex shrink-0 items-center">
                            {statusIcon(flow.status, presentation.severity, checking || inProgress)}
                        </span>
                        <span className="truncate">
                            {t("settings.ui.auth.providerStatus", { provider: "ChatGPT", status: label })}
                        </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                        <button
                            className={PRIMARY_BUTTON_CLASS}
                            disabled={actionsDisabled}
                            onClick={() => void flow.start()}
                            type="button">
                            {authenticated ? t("settings.ui.auth.signInAgain") : t("settings.ui.auth.signIn")}
                        </button>
                        {authenticated ? (
                            <button
                                className={DANGER_BUTTON_CLASS}
                                disabled={actionsDisabled}
                                onClick={() => void flow.signOut()}
                                type="button">
                                {t("settings.ui.auth.signOut")}
                            </button>
                        ) : null}
                    </span>
                </ProfileActionRow>
                {authenticated ? (
                    <div
                        aria-label={t("settings.ui.auth.signedInAccount", { provider: "ChatGPT" })}
                        className="mt-2 min-w-0 border-t border-editor-widget-border/50 pt-2 text-xs text-description"
                        role="group">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium text-foreground">
                                {accountName ?? accountEmail ?? t("settings.ui.auth.account", { provider: "ChatGPT" })}
                            </span>
                            {accountType ? (
                                <span className="shrink-0 rounded-full border border-editor-widget-border bg-toolbar-hover/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                                    {accountType}
                                </span>
                            ) : null}
                        </div>
                        {accountEmail && accountEmail !== accountName ? (
                            <div className="mt-0.5 truncate">{accountEmail}</div>
                        ) : null}
                        {accountExpiry ? (
                            <div className="mt-0.5 truncate">{t("settings.ui.auth.expires", { date: accountExpiry })}</div>
                        ) : null}
                        <OpenAiCodexUsage enabled profileId={profileId} />
                    </div>
                ) : null}
            </div>
            {presentation.severity === "attention" && !inProgress ? (
                <ProfileNotice variant="warning">{presentation.guidance}</ProfileNotice>
            ) : null}
            {blockingError ? <ProfileNotice variant="error">{blockingError}</ProfileNotice> : null}
            <OpenAiCodexOAuthDialog
                busy={flow.busy}
                error={flow.actionError}
                flow={flow.dialog.flow}
                onCancel={flow.cancel}
                onComplete={flow.complete}
                onImport={flow.importCredential}
                onRestart={flow.start}
                onTimedOut={flow.markTimedOut}
                open={flow.dialog.phase !== "closed"}
                phase={flow.dialog.phase}
            />
        </ProfileSection>
    )
}
