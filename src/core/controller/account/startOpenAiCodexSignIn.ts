import { OpenAiCodexAuthFlow, type OpenAiCodexProfileRequest } from "@shared/proto/dline/account"
import { ShowMessageType } from "@shared/proto/dline/host/window"
import { HostProvider } from "@/hosts/host-provider"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { OAuthFlowError } from "@/services/oauth"
import type { Controller } from ".."
import { logOpenAiCodexOAuthFailure, requireOpenAiCodexProfile, toOpenAiCodexAuthFlow } from "./openAiCodexProfileTarget"

/** Starts a browser OAuth flow owned by one explicit OpenAI Codex Profile. */
export async function startOpenAiCodexSignIn(
    controller: Controller,
    request: OpenAiCodexProfileRequest,
): Promise<OpenAiCodexAuthFlow> {
    const profile = await requireOpenAiCodexProfile(request.profileId)
    try {
        const started = await openAiCodexOAuthManager.startAuthorizationFlow(profile.id)
        void started.result
            .then(async () => {
                HostProvider.window.showMessage({
                    type: ShowMessageType.INFORMATION,
                    message: "Successfully signed in to OpenAI Codex",
                })
                await controller.postStateToWebview()
            })
            .catch((error: unknown) => {
                const code = error instanceof OAuthFlowError ? error.code : "UNKNOWN"
                logOpenAiCodexOAuthFailure("browser flow", error)
                if (code !== "FLOW_TIMED_OUT" && code !== "FLOW_CANCELLED") {
                    HostProvider.window.showMessage({
                        type: ShowMessageType.ERROR,
                        message: "OpenAI Codex sign in failed. Please try again.",
                    })
                }
            })
        return toOpenAiCodexAuthFlow(started)
    } catch (error) {
        logOpenAiCodexOAuthFailure("start flow", error)
        throw new Error("OpenAI Codex sign-in could not be started.")
    }
}
