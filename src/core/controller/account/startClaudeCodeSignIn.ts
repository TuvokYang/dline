import { ClaudeCodeAuthFlow, type ClaudeCodeProfileRequest } from "@shared/proto/dline/account"
import { ShowMessageType } from "@shared/proto/dline/host/window"
import { HostProvider } from "@/hosts/host-provider"
import { claudeCodeOAuthManager } from "@/integrations/anthropic-claude-code/oauth"
import { OAuthFlowError } from "@/services/oauth"
import type { Controller } from ".."
import { logClaudeCodeOAuthFailure, requireClaudeCodeProfile, toClaudeCodeAuthFlow } from "./claudeCodeProfileTarget"

/** Starts a subscription OAuth flow owned by one explicit Claude Code Profile. */
export async function startClaudeCodeSignIn(
	controller: Controller,
	request: ClaudeCodeProfileRequest,
): Promise<ClaudeCodeAuthFlow> {
	const profile = await requireClaudeCodeProfile(request.profileId)
	try {
		const flow = await claudeCodeOAuthManager.startAuthorizationFlow(profile.id)
		return toClaudeCodeAuthFlow(flow)
	} catch (error) {
		logClaudeCodeOAuthFailure("start flow", error)
		if (error instanceof OAuthFlowError && error.code === "FLOW_ALREADY_IN_PROGRESS") {
			throw new Error("Another sign-in is already in progress. Finish or cancel it first.")
		}
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: "Claude Code sign-in could not be started.",
		})
		await controller.postStateToWebview()
		throw new Error("Claude Code sign-in could not be started.")
	}
}
