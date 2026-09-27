import type { ClaudeCodeProfileRequest } from "@shared/proto/dline/account"
import { Empty } from "@shared/proto/dline/common"
import { claudeCodeOAuthManager } from "@/integrations/anthropic-claude-code/oauth"
import type { Controller } from ".."
import { logClaudeCodeOAuthFailure, requireClaudeCodeProfile } from "./claudeCodeProfileTarget"

/** Signs out one Profile, clearing only its own credential document. */
export async function signOutClaudeCodeProfile(controller: Controller, request: ClaudeCodeProfileRequest): Promise<Empty> {
	const profile = await requireClaudeCodeProfile(request.profileId)
	try {
		await claudeCodeOAuthManager.signOut(profile.id)
	} catch (error) {
		logClaudeCodeOAuthFailure("sign out", error)
		throw new Error("Claude Code sign-out could not be completed.")
	}
	await controller.postStateToWebview()
	return Empty.create()
}
