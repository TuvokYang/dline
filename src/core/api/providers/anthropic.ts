import { Anthropic } from "@anthropic-ai/sdk"
import type {
	MessageCreateParamsStreaming as BetaMessageCreateParamsStreaming,
	BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import type { MessageCreateParamsStreaming as AnthropicMessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages/messages"
import { Stream as AnthropicStream } from "@anthropic-ai/sdk/streaming"
import { ANTHROPIC_FAST_MODE_SUFFIX, AnthropicModelId, anthropicDefaultModelId, anthropicModels, ModelInfo } from "@shared/api"
import { providerFetch } from "@shared/net"
import { prioritizeApiFormat } from "@shared/providers/api-format"
import { buildEffectiveModelInfo, selectContextTier } from "@shared/providers/effective-model-info"
import {
	canDisableClaudeAdaptiveThinking,
	isClaudeAdaptiveThinkingEnabledByDefault,
	isClaudeOpusAdaptiveThinkingModel,
	resolveClaudeOpusAdaptiveThinking,
	resolveClaudeThinkingDisplay,
	supportsClaudeForcedToolUse,
} from "@shared/utils/reasoning-support"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { ClineStorageMessage } from "@/shared/messages/content"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { ApiHandler, ApiHandlerContext, type ApiRequestOptions } from "../index"
import { withRetry } from "../retry"
import { sanitizeAnthropicMessages } from "../transform/anthropic-format"
import { ApiStream } from "../transform/stream"
import { handleAnthropicMessagesApiStreamResponse, mergeAnthropicServerTools } from "../utils/messages_api_support"

export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01"

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
		return this.ctx.profile.modelId || ""
	}
	private get modelInfo() {
		return this.ctx.profile.modelInfo as ModelInfo | undefined
	}
	private get baseUrl() {
		return this.ctx.profile.baseUrl
	}
	private get reasoningEffort() {
		return this.config?.reasoning?.effort
	}
	private get thinkingBudgetTokens() {
		return this.config?.reasoning?.thinkingBudget ?? 0
	}

	/** This handler always speaks the Anthropic Messages protocol. */
	getSelectedApiFormat(): ApiFormat {
		return ApiFormat.ANTHROPIC_CHAT
	}

	supportsServerTool(tool: ServerTool): boolean {
		return tool === ServerTool.WEB_SEARCH || tool === ServerTool.CODE_EXECUTION
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
				this.client = new Anthropic({
					apiKey: this.apiKey,
					baseURL: this.baseUrl || undefined,
					maxRetries: 0,
					defaultHeaders: buildExternalBasicHeaders(),
					fetch: providerFetch,
				})
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
		const client = this.ensureClient()

		const model = this.getModel()
		let stream: AnthropicStream<Anthropic.RawMessageStreamEvent> | AsyncIterable<BetaRawMessageStreamEvent>

		const useFastMode = model.id.endsWith(ANTHROPIC_FAST_MODE_SUFFIX)
		const modelId = useFastMode ? model.id.slice(0, -ANTHROPIC_FAST_MODE_SUFFIX.length) : model.id
		const selectedTier = selectContextTier(model.info.capabilities, this.config?.enableLongContext !== false)
		const apiModelId = this.resolveApiModelId(model.id, model.info)
		const enable1mContextWindow = Boolean(selectedTier?.apiModelSuffix)
		const fastModeBetas = enable1mContextWindow
			? [ANTHROPIC_FAST_MODE_BETA, "context-1m-2025-08-07"]
			: [ANTHROPIC_FAST_MODE_BETA]
		const createFastModeMessage = (
			body: AnthropicMessageCreateParamsStreaming,
		): Promise<AsyncIterable<BetaRawMessageStreamEvent>> => {
			return (
				client.beta.messages.create as unknown as (
					params: BetaMessageCreateParamsStreaming & { speed: "fast" },
				) => Promise<AsyncIterable<BetaRawMessageStreamEvent>>
			)({
				...body,
				betas: fastModeBetas,
				speed: "fast",
			})
		}

		const budget_tokens = this.thinkingBudgetTokens
		const requestedThinkingEnabled =
			this.config?.reasoning?.enableThinking ?? Boolean(this.reasoningEffort || budget_tokens > 0)

		const localNativeToolsOn = tools !== undefined && tools.length > 0
		const requestTools = mergeAnthropicServerTools(tools, options?.serverTools)
		// Tools are available only when local functions or resolved hosted tools are enabled.
		const nativeToolsOn = requestTools !== undefined && requestTools.length > 0
		// `tool_choice: any` only admits client tools, so forcing it would make a merged
		// hosted server tool unreachable for the whole request.
		const hostedServerToolsOn = (options?.serverTools?.length ?? 0) > 0
		// Fable 5.1 rejects a forced tool choice outright, so it must fall back to auto
		// rather than inheriting the adaptive-thinking branch that forces `any`.
		const forcedToolUseOn = supportsClaudeForcedToolUse(modelId)
		const reasoningOn =
			requestedThinkingEnabled && (model.info.capabilities?.supportsReasoning ?? false) && budget_tokens !== 0

		// Effective model metadata is authoritative for built-in adaptive-thinking support.
		const modelThinking = model.info.capabilities?.thinking ?? anthropicModels[modelId]?.capabilities?.thinking
		const isCustomModel = !anthropicModels[modelId]
		const hasReasoningEffort = requestedThinkingEnabled && this.reasoningEffort && this.reasoningEffort !== "none"
		const supportsAdaptiveThinking =
			modelThinking?.supported === true && modelThinking.mode === "effort" && (modelThinking.effortLevels?.length ?? 0) > 0
		const isAdaptiveThinkingModel = isCustomModel
			? isClaudeOpusAdaptiveThinkingModel(modelId) || Boolean(hasReasoningEffort)
			: supportsAdaptiveThinking
		const adaptiveThinking = isAdaptiveThinkingModel
			? resolveClaudeOpusAdaptiveThinking(this.reasoningEffort, budget_tokens)
			: undefined
		const disableAdaptiveThinkingRequested =
			this.config?.reasoning?.enableThinking === false || this.reasoningEffort === "none"
		const adaptiveThinkingRequired = isAdaptiveThinkingModel && !canDisableClaudeAdaptiveThinking(modelId)
		const adaptiveThinkingEnabled =
			isAdaptiveThinkingModel &&
			(adaptiveThinkingRequired ||
				(!disableAdaptiveThinkingRequested &&
					(requestedThinkingEnabled ||
						isClaudeAdaptiveThinkingEnabledByDefault(modelId) ||
						adaptiveThinking?.enabled === true)))
		const supportedEfforts = modelThinking?.effortLevels ?? []
		const adaptiveThinkingEffort =
			adaptiveThinking?.effort === "xhigh" && !supportedEfforts.includes("xhigh") && supportedEfforts.includes("max")
				? "max"
				: adaptiveThinking?.effort
		const thinkingEnabled = isAdaptiveThinkingModel ? adaptiveThinkingEnabled : reasoningOn
		// An unset display is omitted from the request so the API default applies.
		// The disabled config carries no thinking content, so it takes no display.
		const thinkingDisplay = resolveClaudeThinkingDisplay(this.config?.reasoning?.display)
		const displayField = thinkingDisplay ? { display: thinkingDisplay } : {}
		const thinkingConfig = isAdaptiveThinkingModel
			? adaptiveThinkingEnabled
				? { type: "adaptive" as const, ...displayField }
				: disableAdaptiveThinkingRequested && canDisableClaudeAdaptiveThinking(modelId)
					? { type: "disabled" as const }
					: undefined
			: reasoningOn
				? { type: "enabled" as const, budget_tokens: budget_tokens, ...displayField }
				: undefined
		const outputConfig =
			isAdaptiveThinkingModel && adaptiveThinkingEnabled && adaptiveThinkingEffort
				? { effort: adaptiveThinkingEffort }
				: undefined
		const maxOutputTokens =
			options?.generation?.purpose === "compaction"
				? options.generation.maxOutputTokens
				: model.info.capabilities?.maxTokens || 8192

		if (model.info.capabilities?.supportsPromptCache) {
			const anthropicMessages = sanitizeAnthropicMessages(messages, true)
			const requestBody: AnthropicMessageCreateParamsStreaming & Record<string, unknown> = {
				model: apiModelId,
				thinking: thinkingConfig,
				max_tokens: maxOutputTokens,
				// "Thinking isn't compatible with temperature, top_p, or top_k modifications as well as forced tool use."
				// (https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking#important-considerations-when-using-extended-thinking)
				// Adaptive Claude models do not support temperature.
				temperature: isAdaptiveThinkingModel ? undefined : reasoningOn ? undefined : 0,
				system: [
					{
						text: systemPrompt,
						type: "text",
						cache_control: { type: "ephemeral" },
					},
				], // setting cache breakpoint for system prompt so new tasks can reuse it
				messages: anthropicMessages,
				// tools, // cache breakpoints go from tools > system > messages, and since tools dont change, we can just set the breakpoint at the end of system (this avoids having to set a breakpoint at the end of tools which by itself does not meet min requirements for haiku caching)
				stream: true,
				tools: nativeToolsOn ? requestTools : undefined,
				// tool_choice options:
				// - none: disables tool use, even if tools are provided. Claude will not call any tools.
				// - auto: allows Claude to decide whether to call any provided tools or not. This is the default value when tools are provided.
				// - any: tells Claude that it must use one of the provided tools, but doesn't force a particular tool.
				// Manual extended thinking cannot force tools, but adaptive thinking supports tool_choice.
				tool_choice: !localNativeToolsOn
					? undefined
					: hostedServerToolsOn || !forcedToolUseOn
						? { type: "auto" }
						: !thinkingEnabled || isAdaptiveThinkingModel
							? { type: "any" }
							: undefined,
			}
			if (outputConfig) {
				requestBody.output_config = outputConfig
			}

			stream = useFastMode
				? await createFastModeMessage(requestBody)
				: await client.messages.create(
						requestBody,
						enable1mContextWindow ? { headers: { "anthropic-beta": "context-1m-2025-08-07" } } : undefined,
					)
		} else {
			const requestBody: AnthropicMessageCreateParamsStreaming & Record<string, unknown> = {
				model: apiModelId,
				max_tokens: maxOutputTokens,
				temperature: isAdaptiveThinkingModel ? undefined : reasoningOn ? undefined : 0,
				system: [{ text: systemPrompt, type: "text" }],
				messages: sanitizeAnthropicMessages(messages, false),
				tools: nativeToolsOn ? requestTools : undefined,
				tool_choice: thinkingEnabled ? undefined : { type: "auto" },
				stream: true,
				thinking: thinkingConfig,
			}
			if (outputConfig) {
				requestBody.output_config = outputConfig
			}

			stream = useFastMode
				? await createFastModeMessage(requestBody)
				: await client.messages.create(
						requestBody,
						enable1mContextWindow ? { headers: { "anthropic-beta": "context-1m-2025-08-07" } } : undefined,
					)
		}

		yield* handleAnthropicMessagesApiStreamResponse(stream)
	}

	/**
	 * Resolve the Anthropic model ID and metadata for the current profile.
	 *
	 * @returns Configured model ID and model metadata without replacing custom IDs.
	 */
	getModel(): { id: AnthropicModelId; info: ModelInfo } {
		const mid = this.modelId
		if (mid && this.modelInfo) {
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
