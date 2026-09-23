import { OpenAiCodexAuthStatus } from "@shared/proto/dline/account"
import { CheckCircle2Icon, CircleDashedIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react"
import { type ReactNode, useEffect } from "react"
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

function statusPresentation(status: OpenAiCodexAuthStatus): StatusPresentation {
	switch (status) {
		case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED:
			return { label: "Signed in", severity: "normal" }
		case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_REFRESHABLE_EXPIRED:
			return { label: "Signed in · refreshing", severity: "normal" }
		case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_LEGACY_SHARED:
			return {
				label: "Sign-in required",
				severity: "attention",
				guidance: "This profile needs its own ChatGPT sign-in.",
			}
		case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MALFORMED:
			return {
				label: "Invalid credential",
				severity: "attention",
				guidance: "The stored credential cannot be read. Sign in again.",
			}
		case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_REAUTHENTICATION_REQUIRED:
			return {
				label: "Sign-in expired",
				severity: "attention",
				guidance: "The credential can no longer refresh. Sign in again.",
			}
		case OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MISSING:
			return { label: "Not signed in", severity: "normal" }
		default:
			return { label: "Checking", severity: "normal" }
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
	const flow = useOpenAiCodexOAuthFlow(profileId)
	const authenticated = isOpenAiCodexAuthenticated(flow.status)
	const presentation = statusPresentation(flow.status)
	const inProgress = flow.dialog.phase === "starting" || flow.dialog.phase === "active" || flow.dialog.phase === "completing"
	const checking = !inProgress && flow.status === OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_UNSPECIFIED
	const label = inProgress ? "Signing in" : presentation.label
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
		<ProfileSection aria-label="ChatGPT account">
			<div className="min-w-0 rounded-xs border border-editor-widget-border/60 bg-toolbar-hover/20 p-2">
				<ProfileActionRow className="justify-between gap-2">
					<span className="flex min-w-0 items-center gap-1.5 text-xs text-description">
						<span aria-hidden="true" className="flex shrink-0 items-center">
							{statusIcon(flow.status, presentation.severity, checking || inProgress)}
						</span>
						<span className="truncate">ChatGPT: {label}</span>
					</span>
					<span className="flex shrink-0 items-center gap-2">
						<button
							className={PRIMARY_BUTTON_CLASS}
							disabled={actionsDisabled}
							onClick={() => void flow.start()}
							type="button">
							{authenticated ? "Sign in again" : "Sign in"}
						</button>
						{authenticated ? (
							<button
								className={DANGER_BUTTON_CLASS}
								disabled={actionsDisabled}
								onClick={() => void flow.signOut()}
								type="button">
								Sign out
							</button>
						) : null}
					</span>
				</ProfileActionRow>
				{authenticated ? (
					<div
						aria-label="Signed-in ChatGPT account"
						className="mt-2 min-w-0 border-t border-editor-widget-border/50 pt-2 text-xs text-description"
						role="group">
						<div className="flex min-w-0 items-center gap-2">
							<span className="truncate font-medium text-foreground">
								{accountName ?? accountEmail ?? "ChatGPT account"}
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
						{accountExpiry ? <div className="mt-0.5 truncate">Sign-in expires {accountExpiry}</div> : null}
						{/* Read on demand like Claude Code: the usage endpoint is
						    billed against the subscription that serves
						    conversations, so a timer would spend that budget. */}
						<OpenAiCodexUsage enabled pollIntervalMs={null} profileId={profileId} />
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
