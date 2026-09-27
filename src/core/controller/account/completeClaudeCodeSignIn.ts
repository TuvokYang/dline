import { ClaudeCodeAuthStatusResponse, type ClaudeCodePastedValueRequest } from "@shared/proto/dline/account"
import { claudeCodeOAuthManager } from "@/integrations/anthropic-claude-code/oauth"
import { OAuthFlowError } from "@/services/oauth"
import type { Controller } from ".."
import {
	logClaudeCodeOAuthFailure,
	requireClaudeCodeFlowId,
	requireClaudeCodeProfile,
	toClaudeCodeAccount,
	toClaudeCodeAuthStatus,
} from "./claudeCodeProfileTarget"

/** Messages that name the user's next action rather than the internal failure. */
const FAILURE_MESSAGES: Partial<Record<string, string>> = {
	FLOW_TIMED_OUT: "This sign-in timed out. Start a new sign-in.",
	FLOW_NOT_FOUND: "This sign-in is no longer active. Start a new sign-in.",
	STATE_MISMATCH: "That value belongs to another sign-in attempt. Start a new sign-in.",
	MANUAL_CODE_INVALID: "Paste the callback URL or the authorization code shown by Claude.",
	CALLBACK_URI_MISMATCH: "That callback URL does not match this sign-in.",
}

/**
 * Completes a flow from one paste field.
 *
 * The coordinator decides whether the pasted value is a callback URL or a bare
 * authorization code, so the user never has to pick a mode.
 */
export async function completeClaudeCodeSignIn(
	controller: Controller,
	request: ClaudeCodePastedValueRequest,
): Promise<ClaudeCodeAuthStatusResponse> {
	const profile = await requireClaudeCodeProfile(request.profileId)
	const flowId = requireClaudeCodeFlowId(request.flowId)
	try {
		await claudeCodeOAuthManager.completeFromPastedValue({
			profileId: profile.id,
			flowId,
			pastedValue: request.pastedValue,
		})
	} catch (error) {
		logClaudeCodeOAuthFailure("complete sign-in", error)
		const code = error instanceof OAuthFlowError ? error.code : "UNKNOWN"
		throw new Error(FAILURE_MESSAGES[code] ?? "Claude Code sign-in could not be completed.")
	}

	const [status, account] = await Promise.all([
		claudeCodeOAuthManager.getAuthStatus(profile.id),
		claudeCodeOAuthManager.getAccount(profile.id),
	])
	await controller.postStateToWebview()
	return ClaudeCodeAuthStatusResponse.create({
		profileId: profile.id,
		status: toClaudeCodeAuthStatus(status),
		account: toClaudeCodeAccount(account),
	})
}
