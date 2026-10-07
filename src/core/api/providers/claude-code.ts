import type { Anthropic } from "@anthropic-ai/sdk"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { resolveProfileModelId } from "@shared/providers/profile-model-info"
import type { BillingAttributionMessage } from "@/integrations/anthropic-claude-code/billing-attribution"
import { getClaudeCodeProfileSessionRegistry } from "@/integrations/anthropic-claude-code/registry"
import { ClaudeCodeUsageClient, toAccountUsage } from "@/integrations/anthropic-claude-code/usage"
import { ClaudeCodeModelId, claudeCodeDefaultModelId, claudeCodeModels, type ModelInfo } from "@/shared/api"
import type { AccountUsageData } from "@/shared/ExtensionMessage"
import type { DocumentInputLimits } from "@/shared/messages/attached-documents"
import { ClineStorageMessage, type HostedToolReplayProtocol } from "@/shared/messages/content"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { getClaudeCodeClientVersionResolver } from "../../model-registry/remote/vendors/claude-code-client-version"
import { type ApiHandler, type ApiHandlerContext, type ApiRequestOptions } from ".."
import { anthropicMessagesDocumentLimits } from "../document-input-limits"
import { withRetry } from "../retry"
import { type ApiStream } from "../transform/stream"
import { streamAnthropicMessagesEndpoint } from "../utils/anthropic-messages-endpoint"
import { createAnthropicClient } from "./anthropic/client-factory"
import { buildClaudeCodeIdentity, type ClaudeCodeIdentity } from "./anthropic/identity"
import { resolveAnthropicReasoning } from "./anthropic/reasoning"
import { buildAnthropicMessagesRequest, prepareAnthropicMessages } from "./anthropic/request-builder"
import { ClaudeCodeSubscriptionTransport } from "./anthropic/transport"

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
		return resolveProfileModelId(this.ctx.profile)
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

	/** Hosted calls this endpoint ran must come back verbatim for the model to keep their results. */
	getHostedToolReplayProtocol(): HostedToolReplayProtocol {
		return "anthropic_messages"
	}

	getDocumentInputLimits(): DocumentInputLimits | undefined {
		return anthropicMessagesDocumentLimits(this.getModel().info)
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
	 * caller presenting itself as the Claude Code client.
	 */
	private buildIdentity(messages: readonly BillingAttributionMessage[]): Promise<ClaudeCodeIdentity> {
		return buildClaudeCodeIdentity({ policy: "required", messages })
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
		this.client = createAnthropicClient({ kind: "bearer", token: accessToken }, { baseUrl: this.baseUrl })
		return this.client
	}

	/**
	 * Force a credential refresh after upstream rejected the token, then bind a client to the result.
	 *
	 * The registry may already have rotated the credential for another caller, so the refreshed token is read
	 * back rather than assumed.
	 */
	private async renewClient(): Promise<Anthropic> {
		await getClaudeCodeProfileSessionRegistry().forceRefresh(this.profileId)
		return this.ensureClient(await this.resolveAccessToken())
	}

	@withRetry()
	async *createMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: AnthropicTool[],
		options?: ApiRequestOptions,
	): ApiStream {
		const accessToken = await this.resolveAccessToken()
		const transport = new ClaudeCodeSubscriptionTransport(this.ensureClient(accessToken), () => this.renewClient())
		const model = this.getModel()

		const anthropicMessages = prepareAnthropicMessages(messages, model.info, options)
		const identity = await this.buildIdentity(anthropicMessages)
		const requestBody = buildAnthropicMessagesRequest({
			model: model.id,
			modelInfo: model.info,
			systemPrompt,
			systemPrefix: identity.systemBlocks,
			messages: anthropicMessages,
			reasoning: resolveAnthropicReasoning(model.info.capabilities, this.config?.reasoning),
			tools,
			options,
			forcedToolChoice: "model_declared",
		})

		for await (const chunk of streamAnthropicMessagesEndpoint({
			messages: requestBody.messages,
			openStream: (continuationMessages) =>
				transport.open({ ...requestBody, messages: continuationMessages }, identity.headers),
		})) {
			// A subscription is billed by plan, not per request, so reporting a
			// token-derived cost here would invent a charge the user never incurs.
			yield chunk.type === "usage" ? { ...chunk, totalCost: 0 } : chunk
		}
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
		const matchingInfo = this.modelInfo?.id === modelId ? this.modelInfo : undefined
		return buildEffectiveModelInfo(modelId, matchingInfo ?? claudeCodeModels[modelId], {
			capabilities: this.config?.capabilities,
		})
	}
}
