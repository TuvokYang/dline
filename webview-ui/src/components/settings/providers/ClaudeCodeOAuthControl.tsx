import { ClaudeCodeAuthStatus } from "@shared/proto/dline/account"
import { CheckCircle2Icon, CircleDashedIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react"
import type { ReactNode } from "react"
import { ProfileActionRow, ProfileNotice, ProfileSection } from "../profile-ui"
import { ClaudeCodeOAuthDialog } from "./ClaudeCodeOAuthDialog"
import { ProviderUsage } from "./ProviderUsage"
import { useClaudeCodeOAuthFlow } from "./useClaudeCodeOAuthFlow"

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

function statusPresentation(status: ClaudeCodeAuthStatus): StatusPresentation {
	switch (status) {
		case ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_AUTHENTICATED:
			return { label: "Signed in", severity: "normal" }
		case ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_REFRESHABLE_EXPIRED:
			return { label: "Signed in · refreshing", severity: "normal" }
		case ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_UNUSABLE_EXPIRED:
			return {
				label: "Sign-in expired",
				severity: "attention",
				guidance: "The credential can no longer refresh. Sign in again.",
			}
		case ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_MALFORMED:
			return {
				label: "Invalid credential",
				severity: "attention",
				guidance: "The stored credential cannot be read. Sign in again.",
			}
		case ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_MISSING:
			return { label: "Not signed in", severity: "normal" }
		default:
			return { label: "Checking", severity: "normal" }
	}
}

/** Both states can serve requests; the expired one refreshes on the next call. */
export function isClaudeCodeAuthenticated(status: ClaudeCodeAuthStatus): boolean {
	return (
		status === ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_AUTHENTICATED ||
		status === ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_REFRESHABLE_EXPIRED
	)
}

function statusIcon(status: ClaudeCodeAuthStatus, severity: StatusSeverity, checking: boolean): ReactNode {
	if (checking) return <LoaderIcon className="size-3.5 animate-spin" />
	if (severity === "attention") return <TriangleAlertIcon className="size-3.5 text-editor-warning-foreground" />
	if (isClaudeCodeAuthenticated(status)) return <CheckCircle2Icon className="size-3.5 text-success" />
	return <CircleDashedIcon className="size-3.5" />
}

/**
 * Claude subscription sign-in for one Profile.
 *
 * Claude Code authenticates against a subscription rather than an API key, so this control owns
 * the OAuth session and mirrors the Codex sign-in presentation.
 */
export function ClaudeCodeOAuthControl({ profileId }: { profileId: string }) {
	const oauth = useClaudeCodeOAuthFlow(profileId)
	const authenticated = isClaudeCodeAuthenticated(oauth.status)
	const presentation = statusPresentation(oauth.status)
	const inProgress = oauth.phase === "starting" || oauth.phase === "active" || oauth.phase === "completing"
	const checking = !inProgress && oauth.status === ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_UNSPECIFIED
	const label = inProgress ? "Signing in" : presentation.label
	const actionsDisabled = oauth.busy || inProgress
	// While the dialog is open it shows the error itself, so surfacing it here too would duplicate it.
	const blockingError = oauth.dialogOpen ? undefined : oauth.error
	const accountName = oauth.account?.displayName?.trim()
	const accountEmail = oauth.account?.email?.trim()
	const organization = oauth.account?.organizationName?.trim()

	return (
		<ProfileSection aria-label="Claude subscription">
			<div className="min-w-0 rounded-xs border border-editor-widget-border/60 bg-toolbar-hover/20 p-2">
				<ProfileActionRow className="justify-between gap-2">
					<span className="flex min-w-0 items-center gap-1.5 text-xs text-description">
						<span aria-hidden="true" className="flex shrink-0 items-center">
							{statusIcon(oauth.status, presentation.severity, checking || inProgress)}
						</span>
						<span className="truncate">Claude: {label}</span>
					</span>
					<span className="flex shrink-0 items-center gap-2">
						<button
							className={PRIMARY_BUTTON_CLASS}
							disabled={actionsDisabled}
							onClick={() => void oauth.signIn()}
							type="button">
							{authenticated ? "Sign in again" : "Sign in"}
						</button>
						{authenticated ? (
							<button
								className={DANGER_BUTTON_CLASS}
								disabled={actionsDisabled}
								onClick={() => void oauth.signOut()}
								type="button">
								Sign out
							</button>
						) : null}
					</span>
				</ProfileActionRow>
				{authenticated ? (
					<div
						aria-label="Signed-in Claude account"
						className="mt-2 min-w-0 border-t border-editor-widget-border/50 pt-2 text-xs text-description"
						role="group">
						<div className="flex min-w-0 items-center gap-2">
							<span className="truncate font-medium text-foreground">
								{accountName ?? accountEmail ?? "Claude account"}
							</span>
							{organization ? (
								<span className="shrink-0 rounded-full border border-editor-widget-border bg-toolbar-hover/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
									{organization}
								</span>
							) : null}
						</div>
						{accountEmail && accountEmail !== accountName ? (
							<div className="mt-0.5 truncate">{accountEmail}</div>
						) : null}
						{/* The subscription usage endpoint is billed against the same
						    account that serves conversations, so this panel reads it on
						    demand only, matching the handler's polling opt-out. */}
						<ProviderUsage enabled pollIntervalMs={null} profileId={profileId} />
					</div>
				) : null}
			</div>
			{presentation.severity === "attention" && !inProgress ? (
				<ProfileNotice variant="warning">{presentation.guidance}</ProfileNotice>
			) : null}
			{blockingError ? <ProfileNotice variant="error">{blockingError}</ProfileNotice> : null}
			<ClaudeCodeOAuthDialog
				busy={oauth.busy}
				error={oauth.error}
				flow={oauth.flow}
				onCancel={oauth.cancel}
				onComplete={oauth.complete}
				onRestart={oauth.signIn}
				onTimedOut={oauth.markTimedOut}
				open={oauth.dialogOpen}
				phase={oauth.phase}
			/>
		</ProfileSection>
	)
}
