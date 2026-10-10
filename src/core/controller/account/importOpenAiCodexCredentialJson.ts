import { Buffer } from "node:buffer"
import { OpenAiCodexAuthStatusResponse, type OpenAiCodexOAuthJsonRequest } from "@shared/proto/dline/account"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import type { Controller } from ".."
import {
    logOpenAiCodexOAuthFailure,
    requireOpenAiCodexProfile,
    toOpenAiCodexAccount,
    toOpenAiCodexAuthStatus,
} from "./openAiCodexProfileTarget"

const MAX_OAUTH_JSON_BYTES = 64 * 1024

export async function importOpenAiCodexCredentialJson(
    _controller: Controller,
    request: OpenAiCodexOAuthJsonRequest,
): Promise<OpenAiCodexAuthStatusResponse> {
    const profile = await requireOpenAiCodexProfile(request.profileId)
    try {
        if (Buffer.byteLength(request.oauthJson, "utf8") > MAX_OAUTH_JSON_BYTES) {
            throw new Error("OAuth credential JSON exceeds the supported size.")
        }
        const credential: unknown = JSON.parse(request.oauthJson)
        await openAiCodexOAuthManager.importCredentials(profile.id, credential)
        const context = await openAiCodexOAuthManager.getAccountIdentity(profile.id)
        const status = await openAiCodexOAuthManager.getAuthStatus(profile.id)
        return OpenAiCodexAuthStatusResponse.create({
            profileId: profile.id,
            status: toOpenAiCodexAuthStatus(status),
            account: toOpenAiCodexAccount(context),
        })
    } catch (error) {
        logOpenAiCodexOAuthFailure("import credential", error)
        throw new Error("The OpenAI Codex OAuth credential could not be imported.")
    }
}
