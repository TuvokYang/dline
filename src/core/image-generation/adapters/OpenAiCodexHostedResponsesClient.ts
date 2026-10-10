import { openAiCodexOAuthManager } from "@integrations/openai-codex/oauth"
import { resolveOpenAiCodexRuntimeConfig } from "@integrations/openai-codex/runtime-config"
import { buildExternalBasicHeaders } from "@services/EnvUtils"
import { providerFetch } from "@shared/net"
import OpenAI from "openai"
import { ImageGenerationError } from "../contracts"

interface HostedResponsesClient {
    responses: {
        create(
            params: OpenAI.Responses.ResponseCreateParamsStreaming,
            options?: { signal?: AbortSignal },
        ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>
    }
}

interface OpenAiCodexHostedResponsesClientOptions {
    readonly profileId: string
    readonly workspaceId?: string
    readonly threadId?: string
}

function statusOf(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null || !("status" in error)) return undefined
    const status = (error as { status?: unknown }).status
    return typeof status === "number" ? status : undefined
}

/** OAuth-backed Responses client used by GPT Subscription and Hosted image generation on a Codex Profile. */
export class OpenAiCodexHostedResponsesClient implements HostedResponsesClient {
    private readonly runtimeConfig = resolveOpenAiCodexRuntimeConfig()

    readonly responses = {
        create: async (
            params: OpenAI.Responses.ResponseCreateParamsStreaming,
            options?: { signal?: AbortSignal },
        ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>> => {
            let credential = await openAiCodexOAuthManager.getCredentialContext(this.options.profileId)
            if (!credential) {
                throw new ImageGenerationError({
                    code: "provider_error",
                    message: "OpenAI Codex authentication is required for GPT Subscription image generation.",
                    retryable: false,
                })
            }

            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    return await this.createWithCredential(params, credential, options?.signal)
                } catch (error) {
                    if (statusOf(error) !== 401 || attempt > 0) throw error
                    const refreshed = await openAiCodexOAuthManager.forceRefreshCredentialContext(this.options.profileId)
                    if (!refreshed) throw error
                    credential = refreshed
                }
            }
            throw new Error("OpenAI Codex image request retry exhausted")
        },
    }

    constructor(private readonly options: OpenAiCodexHostedResponsesClientOptions) {}

    private async createWithCredential(
        params: OpenAI.Responses.ResponseCreateParamsStreaming,
        credential: { accessToken: string; accountId?: string },
        signal?: AbortSignal,
    ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>> {
        const routingHeaders: Record<string, string> = {}
        if (this.options.workspaceId) {
            routingHeaders["session-id"] = this.options.workspaceId
        }
        if (this.options.threadId) {
            routingHeaders["thread-id"] = this.options.threadId
            routingHeaders["x-client-request-id"] = this.options.threadId
        }
        const client = new OpenAI({
            apiKey: credential.accessToken,
            baseURL: this.runtimeConfig.apiBaseUrl,
            fetch: providerFetch,
            defaultHeaders: {
                originator: "dline",
                ...buildExternalBasicHeaders(),
                ...(credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {}),
                ...routingHeaders,
            },
        })
        return (await client.responses.create(params, { signal })) as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
    }
}
