import { OpenAiCodexAuthStatusResponse, type OpenAiCodexCallbackUriRequest } from "@shared/proto/dline/account"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { OAuthFlowError } from "@/services/oauth"
import type { Controller } from ".."
import {
    logOpenAiCodexOAuthFailure,
    requireOpenAiCodexFlowId,
    requireOpenAiCodexProfile,
    toOpenAiCodexAccount,
    toOpenAiCodexAuthStatus,
} from "./openAiCodexProfileTarget"

export async function completeOpenAiCodexCallbackUri(
    _controller: Controller,
    request: OpenAiCodexCallbackUriRequest,
): Promise<OpenAiCodexAuthStatusResponse> {
    const profile = await requireOpenAiCodexProfile(request.profileId)
    const flowId = requireOpenAiCodexFlowId(request.flowId)
    try {
        await openAiCodexOAuthManager.completeFromCallbackUri({
            profileId: profile.id,
            flowId,
            callbackUri: request.callbackUri,
        })
        const context = await openAiCodexOAuthManager.getAccountIdentity(profile.id)
        const status = await openAiCodexOAuthManager.getAuthStatus(profile.id)
        return OpenAiCodexAuthStatusResponse.create({
            profileId: profile.id,
            status: toOpenAiCodexAuthStatus(status),
            account: toOpenAiCodexAccount(context),
        })
    } catch (error) {
        logOpenAiCodexOAuthFailure("complete callback", error)
        if (error instanceof OAuthFlowError && error.code === "FLOW_TIMED_OUT") {
            throw new Error("OpenAI Codex OAUTH authentication timed out. Start a new authentication flow.")
        }
        throw new Error("OpenAI Codex sign-in could not be completed.")
    }
}
