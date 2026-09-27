import {
	ClaudeCodeAccount,
	ClaudeCodeAuthFlow,
	ClaudeCodeAuthStatus,
	OpenAiCodexBrowserOpenStatus,
} from "@shared/proto/dline/account"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { readApiProfilesFresh } from "@/core/controller/file/getApiProfiles"
import type { ClaudeCodeAccountIdentity, ClaudeCodeAuthorizationFlow } from "@/integrations/anthropic-claude-code/oauth"
import type { ClaudeCodeAuthStatus as ClaudeCodeProfileAuthStatus } from "@/integrations/anthropic-claude-code/session"
import { OAuthFlowError } from "@/services/oauth"
import { Logger } from "@/shared/services/Logger"

export async function requireClaudeCodeProfile(profileId: string): Promise<ApiProfile> {
	if (typeof profileId !== "string" || profileId.length === 0) {
		throw new Error("A Claude Code Profile ID is required.")
	}
	const profile = (await readApiProfilesFresh()).find((candidate) => candidate.id === profileId)
	if (!profile || profile.provider !== "claude-code") {
		throw new Error("The requested Claude Code Profile does not exist.")
	}
	return profile
}

export function requireClaudeCodeFlowId(flowId: string): string {
	if (typeof flowId !== "string" || flowId.length === 0) {
		throw new Error("A Claude Code OAuth flow ID is required.")
	}
	return flowId
}

export function toClaudeCodeAuthStatus(status: ClaudeCodeProfileAuthStatus): ClaudeCodeAuthStatus {
	switch (status) {
		case "missing":
			return ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_MISSING
		case "malformed":
			return ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_MALFORMED
		case "authenticated":
			return ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_AUTHENTICATED
		case "refreshable_expired":
			return ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_REFRESHABLE_EXPIRED
		case "unusable_expired":
			return ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_UNUSABLE_EXPIRED
	}
}

export function toClaudeCodeAccount(identity: ClaudeCodeAccountIdentity | null): ClaudeCodeAccount | undefined {
	if (!identity) return undefined
	return ClaudeCodeAccount.create({
		displayName: identity.displayName,
		email: identity.email,
		organizationName: identity.organizationName,
		expiresAtMs: identity.expiresAtMs,
	})
}

export function toClaudeCodeAuthFlow(flow: ClaudeCodeAuthorizationFlow): ClaudeCodeAuthFlow {
	return ClaudeCodeAuthFlow.create({
		profileId: flow.profileId,
		flowId: flow.flowId,
		authorizationUrl: flow.authorizationUrl,
		manualAuthorizationUrl: flow.manualAuthorizationUrl,
		expiresAtMs: flow.expiresAtMs,
		browserOpenStatus:
			flow.browserOpenStatus === "opened"
				? OpenAiCodexBrowserOpenStatus.OPEN_AI_CODEX_BROWSER_OPEN_STATUS_OPENED
				: OpenAiCodexBrowserOpenStatus.OPEN_AI_CODEX_BROWSER_OPEN_STATUS_FAILED,
		loopbackListening: flow.loopbackListening,
	})
}

/** Logs only the error code, because OAuth failures can carry credential material. */
export function logClaudeCodeOAuthFailure(action: string, error: unknown): void {
	const code = error instanceof OAuthFlowError ? error.code : "UNKNOWN"
	Logger.error(`[ClaudeCodeOAuth] ${action} failed (${code}).`)
}
