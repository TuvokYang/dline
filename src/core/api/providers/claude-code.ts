import { Anthropic } from "@anthropic-ai/sdk"
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages/messages"
import { providerFetch } from "@shared/net"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { buildClaudeCodeBetas } from "@/integrations/anthropic-claude-code/beta-headers"
import {
	type BillingAttributionMessage,
	buildBillingAttributionBlock,
} from "@/integrations/anthropic-claude-code/billing-attribution"
import { buildClaudeCodeClientHeaders } from "@/integrations/anthropic-claude-code/client-headers"
import { getClaudeCodeProfileSessionRegistry } from "@/integrations/anthropic-claude-code/registry"
import { ClaudeCodeUsageClient, toAccountUsage } from "@/integrations/anthropic-claude-code/usage"
import { ClaudeCodeModelId, claudeCodeDefaultModelId, claudeCodeModels, type ModelInfo } from "@/shared/api"
import type { AccountUsageData } from "@/shared/ExtensionMessage"
import { ClineStorageMessage } from "@/shared/messages/content"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { getClaudeCodeClientVersionResolver } from "../../model-registry/remote/vendors/claude-code-client-version"
import { type ApiHandler, type ApiHandlerContext, type ApiRequestOptions } from ".."
import { withRetry } from "../retry"
import { sanitizeAnthropicMessages } from "../transform/anthropic-format"
import { type ApiStream } from "../transform/stream"
import { streamAnthropicMessagesEndpoint } from "../utils/anthropic-messages-endpoint"
import { mergeAnthropicServerTools } from "../utils/messages_api_support"
import { type AnthropicReasoning, resolveAnthropicReasoning } from "./anthropic/reasoning"

/**
 * Claude Code subscription provider.
 *
 * Requests go straight to the Anthropic Messages API using a subscription
 * OAuth token, so the former local CLI subprocess and its limits (no images,
 * no prompt cache, a capped output budget) no longer apply. The client
 * identity is declared unconditionally here, because a subscription token is
 * only accepted from something that presents itself as the Claude Code client.
 */
export class ClaudeCodeHandler implements ApiHandler {
	private client: Anthropic | undefined
	/** Token the cached client was constructed with, so rotation can be detected. */
	private clientAccessToken: string | undefined
	private readonly usageClient = new ClaudeCodeUsageClient()

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.claudeCode
	}
	private get profileId() {
		return this.ctx.profile.id
	}
	private get modelId() {
		return this.ctx.profile.modelId || ""
	}
	private get modelInfo() {
		return this.ctx.profile.modelInfo as ModelInfo | undefined
	}
	private get baseUrl() {
		return this.ctx.profile.baseUrl
	}

	/** This handler always speaks the Anthropic Messages protocol. */
	getSelectedApiFormat(): ApiFormat {
		return ApiFormat.ANTHROPIC_CHAT
	}

	/**
	 * Hosted web search and web fetch are served by the same Messages API the
	 * anthropic provider uses, so the model's declared `tools` decide whether
	 * either one is used.
	 */
	supportsServerTool(tool: ServerTool): boolean {
		return tool === ServerTool.WEB_SEARCH || tool === ServerTool.WEB_FETCH
	}

	/**
	 * Resolve the access token for the bound Profile.
	 *
	 * The session registry refreshes an expired token, so a failure here means
	 * the Profile genuinely needs to sign in again.
	 */
	private async resolveAccessToken(): Promise<string> {
		return getClaudeCodeProfileSessionRegistry().getAccessToken(this.profileId)
	}

	/**
	 * Build the Claude Code identity for one request.
	 *
	 * Unlike the anthropic provider, where this is an opt-in disguise, the
	 * subscription endpoint requires it: the token is only accepted from a
	 * caller presenting itself as the Claude Code client. Sending the request
	 * anyway without a User-Agent or attribution block would trade a local,
	 * explainable failure for a remote 401 that names the wrong cause.
	 */
	private async buildIdentity(
		messages: readonly BillingAttributionMessage[],
	): Promise<{ systemBlocks: Array<{ type: "text"; text: string }>; headers: Record<string, string> }> {
		const clientVersion = (await getClaudeCodeClientVersionResolver().resolve()).version
		try {
			return {
				systemBlocks: [buildBillingAttributionBlock({ messages, clientVersion })],
				headers: buildClaudeCodeClientHeaders(clientVersion),
			}
		} catch (error) {
			throw new Error(
				`Claude Code client identity could not be built, so the subscription request was not sent: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	/**
	 * Whether upstream rejected the request because of the credential itself.
	 *
	 * Only 401 qualifies. A 403 is a decision about what the account may do,
	 * which a new token cannot change, so refreshing would hide the real
	 * reason behind an unrelated failure.
	 */
	private isUnauthorized(error: unknown): boolean {
		return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 401
	}

	/**
	 * Choose the tool policy for a request that declares tools.
	 *
	 * A model that rejects forcing fails the whole request rather than degrading,
	 * so its own declaration decides this. Manual extended thinking cannot be
	 * combined with a forced choice either, which leaves the API default.
	 * `tool_choice: any` only admits client tools, so forcing it while a hosted
	 * tool is merged would make that tool unreachable.
	 */
	private resolveToolChoice(
		model: { id: string; info: ModelInfo },
		reasoning: AnthropicReasoning,
		hostedServerToolsOn: boolean,
	) {
		if (hostedServerToolsOn || model.info.capabilities?.supportsForcedToolUse === false) {
			return { type: "auto" as const }
		}
		if (!reasoning.enabled) return { type: "any" as const }
		return undefined
	}

	/**
	 * Return a client bound to the token the registry resolved for this turn.
	 *
	 * The SDK captures `authToken` at construction, so a cached client keeps
	 * presenting the credential it was built with. The registry refreshes an
	 * expired token between turns, and reusing the stale one would fail every
	 * remaining request of a long task.
	 */
	private ensureClient(accessToken: string): Anthropic {
		if (this.client && this.clientAccessToken === accessToken) {
			return this.client
		}
		this.clientAccessToken = accessToken
		this.client = new Anthropic({
			// A subscription token is a bearer credential, not an API key; sending
			// it as `x-api-key` is rejected.
			apiKey: null,
			authToken: accessToken,
			maxRetries: 0,
			...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
			fetch: providerFetch,
		})
		return this.client
	}

	@withRetry()
	async *createMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: AnthropicTool[],
		options?: ApiRequestOptions,
	): ApiStream {
		const accessToken = await this.resolveAccessToken()
		let client = this.ensureClient(accessToken)
		const model = this.getModel()

		const promptCacheOn = model.info.capabilities?.supportsPromptCache ?? false
		const anthropicMessages = sanitizeAnthropicMessages(messages, promptCacheOn)
		const identity = await this.buildIdentity(anthropicMessages)

		const reasoning = resolveAnthropicReasoning(model.info.capabilities, this.config?.reasoning)
		const localToolsOn = tools !== undefined && tools.length > 0
		const requestTools = mergeAnthropicServerTools(tools, options?.serverTools)
		const hostedServerToolsOn = (options?.serverTools?.length ?? 0) > 0

		const maxOutputTokens =
			options?.generation?.purpose === "compaction"
				? options.generation.maxOutputTokens
				: model.info.capabilities?.maxTokens || 8192

		const requestBody: MessageCreateParamsStreaming & Record<string, unknown> = {
			model: model.id,
			max_tokens: maxOutputTokens,
			// "Thinking isn't compatible with temperature, top_p, or top_k modifications
			// as well as forced tool use." Adaptive models reject temperature outright.
			temperature: reasoning.adaptive || reasoning.enabled ? undefined : 0,
			// The attribution block leads the system array, matching real client traffic.
			// It carries no cache_control of its own, so the breakpoint stays on the
			// system prompt and a new task can reuse the cached prefix.
			system: [
				...identity.systemBlocks,
				{
					type: "text" as const,
					text: systemPrompt,
					...(promptCacheOn ? { cache_control: { type: "ephemeral" as const } } : {}),
				},
			],
			messages: anthropicMessages,
			stream: true,
			...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
			...(requestTools ? { tools: requestTools } : {}),
			...(localToolsOn ? { tool_choice: this.resolveToolChoice(model, reasoning, hostedServerToolsOn) } : {}),
		}
		if (reasoning.outputConfig) {
			requestBody.output_config = reasoning.outputConfig
		}

		for await (const chunk of streamAnthropicMessagesEndpoint({
			messages: requestBody.messages,
			openStream: async (continuationMessages) => {
				const stream = await this.openStream(client, { ...requestBody, messages: continuationMessages }, identity.headers)
				// A 401 refresh replaces the cached SDK client. Reuse it for any later
				// pause_turn continuation instead of presenting the rejected credential again.
				client = this.client ?? client
				return stream
			},
		})) {
			// A subscription is billed by plan, not per request, so reporting a
			// token-derived cost here would invent a charge the user never incurs.
			yield chunk.type === "usage" ? { ...chunk, totalCost: 0 } : chunk
		}
	}

	/**
	 * Open the response stream, recovering once from a rejected credential.
	 *
	 * Expiry is predicted from the stored lifetime, so a token revoked early
	 * still looks valid and upstream answers 401. Retrying is safe only here,
	 * before any event has been yielded: once the stream has produced output,
	 * a second request would duplicate what the caller already consumed.
	 */
	private async openStream(
		client: Anthropic,
		requestBody: MessageCreateParamsStreaming & Record<string, unknown>,
		headers: Record<string, string>,
	): Promise<AsyncIterable<BetaRawMessageStreamEvent>> {
		try {
			return await this.postMessage(client, requestBody, headers)
		} catch (error) {
			if (!this.isUnauthorized(error)) throw error
			// The registry may already have rotated the credential for another
			// caller, so the refreshed token is read back rather than assumed.
			await getClaudeCodeProfileSessionRegistry().forceRefresh(this.profileId)
			const renewed = this.ensureClient(await this.resolveAccessToken())
			return this.postMessage(renewed, requestBody, headers)
		}
	}

	/**
	 * Send one request through the beta namespace, which posts to
	 * `/v1/messages?beta=true`.
	 *
	 * Several declared betas are beta-API features, so the stable route would
	 * not serve what the beta set asks for. The SDK renders `betas` into the
	 * `anthropic-beta` header, keeping route and header from drifting apart.
	 */
	private postMessage(
		client: Anthropic,
		requestBody: MessageCreateParamsStreaming & Record<string, unknown>,
		headers: Record<string, string>,
	): Promise<AsyncIterable<BetaRawMessageStreamEvent>> {
		return (
			client.beta.messages.create as unknown as (
				params: MessageCreateParamsStreaming & Record<string, unknown>,
				options: { headers: Record<string, string> },
			) => Promise<AsyncIterable<BetaRawMessageStreamEvent>>
		)({ ...requestBody, betas: buildClaudeCodeBetas() }, { headers })
	}

	/**
	 * Report subscription usage through the shared provider usage capability.
	 *
	 * Reset credits are intentionally not reported: this subscription exposes no
	 * reset-credit API, and an empty list would render as "none remaining"
	 * rather than "not supported".
	 */
	/**
	 * Report usage only when the user asks for it.
	 *
	 * The subscription usage endpoint is a real upstream request on the same
	 * account that serves conversations, so polling it on a timer spends the
	 * subscription's own request budget to render a number the user may not be
	 * looking at. The value stays reachable through the explicit refresh.
	 */
	readonly supportsAccountUsagePolling = false

	async getAccountUsage(): Promise<AccountUsageData> {
		const accessToken = await this.resolveAccessToken()
		const clientVersion = (await getClaudeCodeClientVersionResolver().resolve()).version
		return toAccountUsage(await this.usageClient.fetchUsage(accessToken, clientVersion))
	}

	/**
	 * Resolve the model ID and metadata for the current Profile.
	 *
	 * A configured ID is never replaced. The settings page can offer a model
	 * discovered from the remote catalog that the bundled one does not list, so
	 * substituting the default would send a different model than the user
	 * selected while still reporting the selection as active.
	 */
	getModel(): { id: ClaudeCodeModelId; info: ModelInfo } {
		const modelId = this.modelId || claudeCodeDefaultModelId
		return { id: modelId as ClaudeCodeModelId, info: this.buildModelInfo(modelId) }
	}

	/**
	 * Build effective metadata for one model ID.
	 *
	 * The bundled catalog is only a base: a remotely discovered model is absent
	 * from it and carries its metadata on the Profile instead, which also wins
	 * over a catalog entry so a newer capability set is not downgraded.
	 */
	private buildModelInfo(modelId: string): ModelInfo {
		return buildEffectiveModelInfo(modelId, this.modelInfo ?? claudeCodeModels[modelId], {
			capabilities: this.config?.capabilities,
		})
	}
}
