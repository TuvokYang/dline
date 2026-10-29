import type { OpenAiCodexProfileRequest } from "@shared/proto/dline/account"
import { Empty } from "@shared/proto/dline/common"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import type { Controller } from ".."
import { logOpenAiCodexOAuthFailure, requireOpenAiCodexProfile } from "./openAiCodexProfileTarget"

/** Signs out one explicit OpenAI Codex Profile. */
export async function signOutOpenAiCodexProfile(controller: Controller, request: OpenAiCodexProfileRequest): Promise<Empty> {
    const profile = await requireOpenAiCodexProfile(request.profileId)
    try {
        await openAiCodexOAuthManager.clearCredentials(profile.id)
        await controller.postStateToWebview()
        return Empty.create({})
    } catch (error) {
        logOpenAiCodexOAuthFailure("sign out", error)
        throw new Error("OpenAI Codex sign-out could not be completed.")
    }
}
