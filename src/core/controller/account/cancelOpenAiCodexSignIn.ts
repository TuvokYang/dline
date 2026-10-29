import type { OpenAiCodexAuthFlowRequest } from "@shared/proto/dline/account"
import { Empty } from "@shared/proto/dline/common"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import type { Controller } from ".."
import { logOpenAiCodexOAuthFailure, requireOpenAiCodexFlowId, requireOpenAiCodexProfile } from "./openAiCodexProfileTarget"

export async function cancelOpenAiCodexSignIn(_controller: Controller, request: OpenAiCodexAuthFlowRequest): Promise<Empty> {
    const profile = await requireOpenAiCodexProfile(request.profileId)
    const flowId = requireOpenAiCodexFlowId(request.flowId)
    try {
        await openAiCodexOAuthManager.cancelAuthorizationFlow(profile.id, flowId)
        return Empty.create({})
    } catch (error) {
        logOpenAiCodexOAuthFailure("cancel flow", error)
        throw new Error("OpenAI Codex sign-in could not be cancelled.")
    }
}
