import type { Anthropic } from "@anthropic-ai/sdk"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { ANTHROPIC_FAST_MODE_SUFFIX, AnthropicModelId, anthropicDefaultModelId, anthropicModels, ModelInfo } from "@shared/api"
import { prioritizeApiFormat } from "@shared/providers/api-format"
import { buildEffectiveModelInfo, selectContextTier } from "@shared/providers/effective-model-info"
import { resolveProfileModelId } from "@shared/providers/profile-model-info"
import type { BillingAttributionMessage } from "@/integrations/anthropic-claude-code/billing-attribution"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { ClineStorageMessage, type HostedToolReplayProtocol } from "@/shared/messages/content"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { ApiHandler, ApiHandlerContext, type ApiRequestOptions } from "../index"
import { withRetry } from "../retry"
import { ApiStream } from "../transform/stream"
import { streamAnthropicMessagesEndpoint } from "../utils/anthropic-messages-endpoint"
import { createAnthropicClient } from "./anthropic/client-factory"
import { buildClaudeCodeIdentity, type ClaudeCodeIdentity } from "./anthropic/identity"
import { resolveAnthropicReasoning } from "./anthropic/reasoning"
import { anthropicPromptCacheOn, buildAnthropicMessagesRequest, prepareAnthropicMessages } from "./anthropic/request-builder"
import { ApiKeyAnthropicTransport } from "./anthropic/transport"

export { ANTHROPIC_FAST_MODE_BETA } from "./anthropic/transport"

export class AnthropicHandler implements ApiHandler {
	private client: Anthropic | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.anthropic
	}
	private get apiKey() {
		return this.ctx.profile.apiKey
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
	private get billingAttributionEnabled() {
		return this.config?.claudeCodeIdentity?.enabled === true
	}

	/**
	 * Resolve the opt-in Claude Code identity for one request.
	 *
	 * Returns nothing when the toggle is off so the request stays byte-identical
	 * to one built without this feature. An identity that cannot be built is
	 * dropped as well, because an API-key request is valid without it.
	 */
	private async resolveClaudeCodeIdentity(messages: readonly BillingAttributionMessage[]): Promise<ClaudeCodeIdentity> {
		if (!this.billingAttributionEnabled) return { systemBlocks: [], headers: {} }
		const identity = this.config?.claudeCodeIdentity
		return buildClaudeCodeIdentity({
			policy: "optional",
			messages,
			clientVersionOverride: identity?.clientVersionOverride,
			entrypointOverride: identity?.entrypointOverride,
		})
	}

	/** This handler always speaks the Anthropic Messages protocol. */
	getSelectedApiFormat(): ApiFormat {
		return ApiFormat.ANTHROPIC_CHAT
	}

	supportsServerTool(tool: ServerTool): boolean {
		return tool === ServerTool.WEB_SEARCH || tool === ServerTool.CODE_EXECUTION || tool === ServerTool.WEB_FETCH
	}

	/** Hosted calls this endpoint ran must come back verbatim for the model to keep their results. */
	getHostedToolReplayProtocol(): HostedToolReplayProtocol {
		return "anthropic_messages"
	}

	private contextWindowTiersEnabled(modelId: string): boolean {
		const registryModel = anthropicModels[modelId]
		return registryModel === undefined || Boolean(registryModel.capabilities?.contextWindowTiers?.length)
	}

	/**
	 * Build model metadata for custom Anthropic-compatible models.
	 *
	 * @param modelId Custom model identifier configured by the user.
	 * @returns ModelInfo using profile overrides, provider custom config, or sane defaults.
	 */
	// The 1M long-context option is enabled by default; only an explicit false disables it.
	// This must match the provider UI default so tasks resolve to the same context window.
	private buildCustomModelInfo(modelId: string): ModelInfo {
		return buildEffectiveModelInfo(modelId, undefined, {
			capabilities: this.config?.capabilities,
			pricing: this.config?.pricing,
			enableLongContext: this.config?.enableLongContext !== false,
			pricingTiersEnabled: this.config?.pricingTiersEnabled,
			preferContextWindowTier: true,
			contextWindowTiersEnabled: this.contextWindowTiersEnabled(modelId),
		})
	}

	/**
	 * Build effective Anthropic registry model metadata with provider overrides.
	 *
	 * @param modelId Selected registry model identifier.
	 * @returns Effective model metadata for display and request handling.
	 */
	private buildRegistryModelInfo(modelId: string): ModelInfo {
		return buildEffectiveModelInfo(modelId, anthropicModels[modelId], {
			capabilities: this.config?.capabilities,
			pricing: this.config?.pricing,
			enableLongContext: this.config?.enableLongContext !== false,
			pricingTiersEnabled: this.config?.pricingTiersEnabled,
			preferContextWindowTier: true,
			contextWindowTiersEnabled: this.contextWindowTiersEnabled(modelId),
		})
	}

	/**
	 * Resolve the model identifier sent to the Anthropic API.
	 *
	 * @param modelId Base registry or custom model identifier.
	 * @param modelInfo Effective metadata containing selectable context tiers.
	 * @returns API model identifier with the selected tier suffix applied.
	 */
	private resolveApiModelId(modelId: AnthropicModelId, modelInfo: ModelInfo): string {
		const baseModelId = modelId.endsWith(ANTHROPIC_FAST_MODE_SUFFIX)
			? modelId.slice(0, -ANTHROPIC_FAST_MODE_SUFFIX.length)
			: modelId
		const tier = selectContextTier(modelInfo.capabilities, this.config?.enableLongContext !== false)
		return `${baseModelId}${tier?.apiModelSuffix ?? ""}`
	}

	private ensureClient(): Anthropic {
		if (!this.client) {
			if (!this.apiKey) {
				throw new Error("Anthropic API key is required")
			}
			try {
				this.client = createAnthropicClient(
					{ kind: "api_key", apiKey: this.apiKey },
					{ baseUrl: this.baseUrl, defaultHeaders: buildExternalBasicHeaders() },
				)
			} catch (error) {
				throw new Error(`Error creating Anthropic client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: AnthropicTool[],
		options?: ApiRequestOptions,
	): ApiStream {
		const model = this.getModel()
		const transport = new ApiKeyAnthropicTransport(this.ensureClient(), model.id.endsWith(ANTHROPIC_FAST_MODE_SUFFIX))

		const anthropicMessages = prepareAnthropicMessages(messages, model.info, options)
		const claudeCodeIdentity = await this.resolveClaudeCodeIdentity(anthropicMessages)
		const requestBody = buildAnthropicMessagesRequest({
			model: this.resolveApiModelId(model.id, model.info),
			modelInfo: model.info,
			systemPrompt,
			systemPrefix: claudeCodeIdentity.systemBlocks,
			messages: anthropicMessages,
			reasoning: resolveAnthropicReasoning(model.info.capabilities, this.config?.reasoning),
			tools,
			options,
			// The route for models without prompt caching has never forced a tool choice; keep that request shape.
			forcedToolChoice: anthropicPromptCacheOn(model.info) ? "model_declared" : "never",
		})

		yield* streamAnthropicMessagesEndpoint({
			messages: requestBody.messages,
			openStream: (continuationMessages) =>
				transport.open({ ...requestBody, messages: continuationMessages }, claudeCodeIdentity.headers),
		})
	}

	/**
	 * Resolve the Anthropic model ID and metadata for the current profile.
	 *
	 * @returns Configured model ID and model metadata without replacing custom IDs.
	 */
	getModel(): { id: AnthropicModelId; info: ModelInfo } {
		const mid = this.modelId
		if (mid && this.modelInfo?.id === mid) {
			return {
				id: mid as AnthropicModelId,
				info: prioritizeApiFormat(
					buildEffectiveModelInfo(mid, this.modelInfo, {
						capabilities: this.config?.capabilities,
						pricing: this.config?.pricing,
						enableLongContext: this.config?.enableLongContext !== false,
						pricingTiersEnabled: this.config?.pricingTiersEnabled,
						preferContextWindowTier: true,
						contextWindowTiersEnabled: this.contextWindowTiersEnabled(mid),
					}),
					ApiFormat.ANTHROPIC_CHAT,
				),
			}
		}
		if (mid && anthropicModels[mid]) {
			const id = mid as AnthropicModelId
			return { id, info: prioritizeApiFormat(this.buildRegistryModelInfo(id), ApiFormat.ANTHROPIC_CHAT) }
		}
		if (mid) {
			return {
				id: mid as AnthropicModelId,
				info: prioritizeApiFormat(this.buildCustomModelInfo(mid), ApiFormat.ANTHROPIC_CHAT),
			}
		}
		return {
			id: anthropicDefaultModelId,
			info: prioritizeApiFormat(this.buildRegistryModelInfo(anthropicDefaultModelId), ApiFormat.ANTHROPIC_CHAT),
		}
	}
}
