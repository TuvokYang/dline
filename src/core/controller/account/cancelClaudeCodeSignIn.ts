import type { ClaudeCodeAuthFlowRequest } from "@shared/proto/dline/account"
import { Empty } from "@shared/proto/dline/common"
import { claudeCodeOAuthManager } from "@/integrations/anthropic-claude-code/oauth"
import type { Controller } from ".."
import { logClaudeCodeOAuthFailure, requireClaudeCodeProfile } from "./claudeCodeProfileTarget"

/** Cancels the active flow for one Profile; an already-ended flow is a no-op. */
export async function cancelClaudeCodeSignIn(_controller: Controller, request: ClaudeCodeAuthFlowRequest): Promise<Empty> {
	const profile = await requireClaudeCodeProfile(request.profileId)
	try {
		await claudeCodeOAuthManager.cancelAuthorizationFlow(profile.id, request.flowId || undefined)
	} catch (error) {
		logClaudeCodeOAuthFailure("cancel flow", error)
		throw new Error("Claude Code sign-in could not be cancelled.")
	}
	return Empty.create()
}
