import { ClaudeCodeAuthStatusResponse, type ClaudeCodeProfileRequest } from "@shared/proto/dline/account"
import { claudeCodeOAuthManager } from "@/integrations/anthropic-claude-code/oauth"
import type { Controller } from ".."
import {
	requireClaudeCodeProfile,
	toClaudeCodeAccount,
	toClaudeCodeAuthFlow,
	toClaudeCodeAuthStatus,
} from "./claudeCodeProfileTarget"

/** Returns the OAuth status, active flow, and display identity for one Profile. */
export async function getClaudeCodeAuthStatus(
	_controller: Controller,
	request: ClaudeCodeProfileRequest,
): Promise<ClaudeCodeAuthStatusResponse> {
	const profile = await requireClaudeCodeProfile(request.profileId)
	const [status, account] = await Promise.all([
		claudeCodeOAuthManager.getAuthStatus(profile.id),
		claudeCodeOAuthManager.getAccount(profile.id),
	])
	const activeFlow = claudeCodeOAuthManager.getActiveAuthorizationFlow(profile.id)
	return ClaudeCodeAuthStatusResponse.create({
		profileId: profile.id,
		status: toClaudeCodeAuthStatus(status),
		activeFlow: activeFlow ? toClaudeCodeAuthFlow(activeFlow) : undefined,
		account: toClaudeCodeAccount(account),
	})
}
