import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import {
	type CompactionWireDiagnosticSnapshot,
	createCompactionWireDiagnosticSnapshot,
	findCompactionWireFirstDivergence,
	hashCompactionDiagnosticValue,
	isCompactionDevDiagnosticsEnabled,
} from "@core/context/context-management/compaction-dev-diagnostics"
import { ModelInfo, openAiModelInfoSaneDefaults, openAiModels } from "@shared/api"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ImageGenerationSource } from "@shared/proto/dline/profile"
import { OpenAiPromptCacheMode } from "@shared/proto/dline/provider/openai"
import { openAiEndpointToApiFormat, prioritizeApiFormat, resolveApiFormat } from "@shared/providers/api-format"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { normalizeOpenAIResponsesStreamIdleTimeoutSeconds } from "@shared/providers/openai-stream"
import { normalizeOpenAiServiceTier } from "@shared/storage/types"
import { calculateApiCostOpenAI } from "@utils/cost"
import OpenAI from "openai"
import type { ChatCompletionChunk, ChatCompletionFunctionTool, ChatCompletionTool } from "openai/resources/chat/completions"
import type { DocumentInputLimits } from "@/shared/messages/attached-documents"
import { ClineStorageMessage, type HostedToolReplayProtocol } from "@/shared/messages/content"
import { isO1Model } from "@/shared/resolve-prompt-profile"
import { Logger } from "@/shared/services/Logger"
import { openAiResponsesDocumentLimits } from "../document-input-limits"
import { ApiHandler, ApiHandlerContext, type ApiRequestOptions } from "../index"
import { withRetry } from "../retry"
import { getOpenAIChatOutputLimitError } from "../stream/OutputLimitExceededError"
import { OpenAIResponsesStreamMonitor } from "../stream/openai-responses-stream-monitor"
import { convertToO1Messages } from "../transform/o1-format"
import { convertToOpenAiMessages } from "../transform/openai-format"
import {
	type OpenAIPromptCacheProjectionMode,
	projectOpenAIChatPromptCache,
	projectOpenAIResponsesPromptCache,
} from "../transform/openai-prompt-cache"
import { convertToOpenAIResponsesInput, declaredResponsesHostedToolNames } from "../transform/openai-response-format"
import { convertToR1Format } from "../transform/r1-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { handleResponsesApiStreamResponse } from "../utils/responses_api_support"
import { encodeOpenAIChatReasoning, encodeOpenAIResponsesReasoning, resolveOpenAIReasoning } from "./openai/reasoning"
import { createOpenAIClientForProfile } from "./openai-client-factory"

type OpenAICompatibleCompletionUsage = NonNullable<ChatCompletionChunk["usage"]> & {
	cache_creation_input_tokens?: number
	cache_read_input_tokens?: number
	prompt_cache_hit_tokens?: number
	prompt_cache_miss_tokens?: number
}

function getChatCacheWriteTokens(details: unknown): number {
	if (typeof details !== "object" || details === null) return 0
	const values = details as { cache_write_tokens?: unknown; cache_miss_tokens?: unknown }
	if (typeof values.cache_write_tokens === "number") return values.cache_write_tokens
	return typeof values.cache_miss_tokens === "number" ? values.cache_miss_tokens : 0
}

function isUnsupportedPromptCacheControlError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false
	const record = error as {
		status?: unknown
		message?: unknown
		body?: unknown
		error?: { message?: unknown; code?: unknown; param?: unknown }
	}
	if (record.status !== 400) return false

	const diagnostic = [record.message, record.body, record.error?.message, record.error?.code, record.error?.param]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
		.toLowerCase()
	return diagnostic.includes("prompt_cache_breakpoint") || diagnostic.includes("prompt_cache_options")
}

export class OpenAiHandler implements ApiHandler {
	private client: OpenAI | undefined
	private requestController: AbortController | undefined
	private explicitPromptCacheRejected = false
	private latestOrdinaryResponsesDiagnostic?: CompactionWireDiagnosticSnapshot

	constructor(private ctx: ApiHandlerContext) {}

	private get routingHeaders(): Record<string, string> | undefined {
		const headers: Record<string, string> = {}
		if (this.ctx.workspaceId) headers["session-id"] = this.ctx.workspaceId
		if (this.ctx.ulid) {
			headers["thread-id"] = this.ctx.ulid
			headers["x-client-request-id"] = this.ctx.ulid
		}
		return Object.keys(headers).length > 0 ? headers : undefined
	}

	private get config() {
		return this.ctx.profile.openai
	}
	private get apiKey() {
		return this.ctx.profile.apiKey
	}
	private get modelId() {
		return this.ctx.profile.modelId || this.ctx.profile.modelInfo?.id || ""
	}
	private get modelInfo() {
		return this.ctx.profile.modelInfo as ModelInfo | undefined
	}
	private get baseUrl() {
		return this.ctx.profile.baseUrl
	}
	private get serviceTier() {
		return this.config?.serviceTierEnabled === true ? normalizeOpenAiServiceTier(this.config?.serviceTier) : undefined
	}
	private get apiFormat() {
		const selected = this.config?.apiFormat ?? openAiEndpointToApiFormat(this.config?.apiEndpoint)
		return resolveApiFormat(selected, this.buildModelInfo(), ApiFormat.OPENAI_CHAT)
	}
	private get azureApiVersion() {
		return this.config?.azureApiVersion
	}
	private get azureIdentity() {
		return this.config?.azureIdentity
	}
	private get openAiHeaders() {
		return this.config?.openAiHeaders
	}
	private get promptCacheProjectionMode(): OpenAIPromptCacheProjectionMode {
		return this.config?.promptCacheMode === OpenAiPromptCacheMode.OPENAI_PROMPT_CACHE_MODE_EXPLICIT &&
			!this.explicitPromptCacheRejected
			? "explicit"
			: "automatic"
	}

	private recordResponsesCompactionDiagnostic(input: {
		requestKind: "ordinary" | "compaction"
		modelId: string
		mode: OpenAIPromptCacheProjectionMode
		taskNamespace?: string
		promptCacheKey: string
		instructions?: unknown
		tools: readonly unknown[]
		wireInput: unknown
	}): void {
		if (!isCompactionDevDiagnosticsEnabled()) return

		const snapshot = createCompactionWireDiagnosticSnapshot(input)
		const ordinaryBaseline = input.requestKind === "ordinary" ? undefined : this.latestOrdinaryResponsesDiagnostic
		Logger.debug("[CompactionDiag] openai-responses-wire", {
			requestKind: input.requestKind,
			modelId: input.modelId,
			mode: input.mode,
			taskNamespaceHash: hashCompactionDiagnosticValue(input.taskNamespace ?? null),
			promptCacheKeyHash: snapshot.promptCacheKeyHash,
			instructionsHash: snapshot.instructionsHash,
			toolsHash: snapshot.toolsHash,
			inputCount: snapshot.inputHashes.length,
			firstInputHash: snapshot.inputHashes[0] ?? null,
			ordinaryBaselineAvailable: ordinaryBaseline !== undefined,
			firstDivergence: ordinaryBaseline ? findCompactionWireFirstDivergence(ordinaryBaseline, snapshot) : null,
		})
		if (input.requestKind === "ordinary") this.latestOrdinaryResponsesDiagnostic = snapshot
	}

	private async createWithPromptCacheFallback<T>(
		mode: OpenAIPromptCacheProjectionMode,
		create: (projectionMode: OpenAIPromptCacheProjectionMode) => Promise<T>,
	): Promise<T> {
		try {
			return await create(mode)
		} catch (error) {
			if (mode !== "explicit" || !isUnsupportedPromptCacheControlError(error)) throw error

			this.explicitPromptCacheRejected = true
			Logger.warn("[OpenAI] Explicit prompt cache controls were rejected; retrying with automatic caching")
			return await create("automatic")
		}
	}

	getSelectedApiFormat(): ApiFormat {
		return this.apiFormat
	}

	supportsServerTool(tool: ServerTool): boolean {
		return tool === ServerTool.WEB_SEARCH && this.usesResponsesApi()
	}

	/** Hosted Web Search calls this endpoint ran go back verbatim; Chat Completions has no hosted call to replay. */
	getHostedToolReplayProtocol(): HostedToolReplayProtocol | undefined {
		return this.usesResponsesApi() ? "openai_responses" : undefined
	}

	/** Responses accepts inline PDFs as `input_file`; Chat Completions keeps extracted text. */
	getDocumentInputLimits(): DocumentInputLimits | undefined {
		return this.usesResponsesApi() ? openAiResponsesDocumentLimits(this.getModel().info) : undefined
	}

	private usesResponsesApi(): boolean {
		return this.apiFormat === ApiFormat.OPENAI_RESPONSES || this.apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE
	}

	/**
	 * Build effective model metadata from defaults and provider overrides.
	 *
	 * @returns Effective model metadata for requests and cost calculation.
	 */
	getImageGenerationSource(): ImageGenerationSource | undefined {
		return this.ctx.profile.imageSource
	}

	private buildModelInfo(): ModelInfo {
		return buildEffectiveModelInfo(
			this.modelId,
			(this.modelInfo?.id === this.modelId ? this.modelInfo : undefined) ??
				openAiModels[this.modelId] ??
				openAiModelInfoSaneDefaults,
			{
				capabilities: this.config?.capabilities,
				pricing: this.config?.pricing,
				enableLongContext: this.config?.enableLongContext,
				pricingTiersEnabled: this.config?.pricingTiersEnabled,
			},
		)
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			try {
				this.client = createOpenAIClientForProfile(this.ctx.profile)
			} catch (error) {
				throw new Error(`Error creating OpenAI client: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: ChatCompletionTool[],
		options?: ApiRequestOptions,
	): ApiStream {
		this.requestController?.abort()
		const requestController = new AbortController()
		this.requestController = requestController
		if (this.usesResponsesApi()) {
			try {
				yield* this.createResponsesMessage(systemPrompt, messages, requestController, tools, options)
			} finally {
				if (this.requestController === requestController) this.requestController = undefined
			}
			return
		}

		const client = this.ensureClient()
		const modelId = this.modelId
		const isO1 = isO1Model(modelId)
		const isDeepseekReasoner = modelId.includes("deepseek-reasoner")
		const isReasoningModelFamily =
			["o1", "o3", "o4", "gpt-5"].some((prefix) => modelId.includes(prefix)) && !modelId.includes("chat")

		let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		const model = this.getModel()

		let temperature: number | undefined
		const capabilityTemp = model.info.capabilities?.temperature
		const configTemp = this.config?.temperature
		temperature =
			capabilityTemp != null
				? Number(capabilityTemp)
				: configTemp != null && configTemp !== 0
					? Number(configTemp)
					: undefined

		let maxTokens: number | undefined

		if (options?.generation?.purpose === "compaction") {
			maxTokens = options.generation.maxOutputTokens
		} else if (model.info.capabilities?.maxTokens && model.info.capabilities.maxTokens > 0) {
			maxTokens = Number(model.info.capabilities.maxTokens)
		} else {
			maxTokens = undefined
		}

		if (isDeepseekReasoner) {
			openAiMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
		}

		const reasoning = resolveOpenAIReasoning(model.info.capabilities, this.config?.reasoning)
		const reasoningParams = encodeOpenAIChatReasoning(model.info.capabilities, this.config?.reasoning)
		if (reasoning.mode === "budget" && reasoning.enabled) {
			openAiMessages = [{ role: "developer", content: systemPrompt }, ...convertToOpenAiMessages(messages)]
		}

		// o1 accepts the Lite XML contract in user messages and cannot replay native tool roles.
		if (isO1) {
			openAiMessages = convertToO1Messages(convertToOpenAiMessages(messages), systemPrompt)
			temperature = undefined
		} else if (isReasoningModelFamily) {
			openAiMessages = [{ role: "developer", content: systemPrompt }, ...convertToOpenAiMessages(messages)]
			temperature = undefined // does not support temperature
		}

		const toolParams = isO1 ? { tools: undefined } : getOpenAIToolParams(tools)
		const buildRequestParams = (mode: OpenAIPromptCacheProjectionMode): OpenAI.Chat.ChatCompletionCreateParamsStreaming => {
			const promptCache = projectOpenAIChatPromptCache({
				modelId,
				systemPrompt,
				messages: openAiMessages,
				tools: toolParams.tools ?? [],
				taskNamespace: options?.taskNamespace,
				mode,
			})
			const requestParams: any = {
				model: modelId,
				messages: promptCache.messages,
				temperature,
				max_tokens: maxTokens,
				stream: true,
				prompt_cache_key: promptCache.promptCacheKey,
				...(promptCache.promptCacheOptions ? { prompt_cache_options: promptCache.promptCacheOptions } : {}),
				...(this.serviceTier ? { service_tier: this.serviceTier } : {}),
			}
			Object.assign(requestParams, reasoningParams)
			if (this.config?.streamIncludeUsage !== false) {
				requestParams.stream_options = { include_usage: true }
			}
			if (!isO1) {
				Object.assign(requestParams, toolParams)
			}
			return requestParams
		}

		const stream = await this.createWithPromptCacheFallback<AsyncIterable<ChatCompletionChunk>>(
			this.promptCacheProjectionMode,
			(mode) =>
				(client.chat.completions as any).create(buildRequestParams(mode), {
					signal: requestController.signal,
					...(this.routingHeaders ? { headers: this.routingHeaders } : {}),
				}),
		)

		const toolCallProcessor = new ToolCallProcessor()

		let usageYielded = false

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				yield {
					type: "reasoning",
					reasoning: (delta.reasoning_content as string | undefined) || "",
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}
			if (options?.generation?.purpose === "compaction" && chunk.choices?.[0]?.finish_reason === "tool_calls") {
				yield* toolCallProcessor.completeToolCalls()
			}

			if (chunk.usage && !usageYielded) {
				usageYielded = true
				// Parse cache tokens from multiple possible field names
				// Different OpenAI-compatible providers use different field names
				const usage = chunk.usage as OpenAICompatibleCompletionUsage
				const rawInputTokens = usage.prompt_tokens || 0
				const outputTokens = usage.completion_tokens || 0
				const cacheReadTokens =
					usage.cache_read_input_tokens ??
					usage.prompt_cache_hit_tokens ??
					usage.prompt_tokens_details?.cached_tokens ??
					0
				const cacheWriteTokens =
					usage.cache_creation_input_tokens ??
					usage.prompt_cache_miss_tokens ??
					getChatCacheWriteTokens(usage.prompt_tokens_details)
				const modelInfo = this.getModel().info
				// Yield inputTokens in Anthropic semantic (excluding cache) so
				// ContextManager and updateApiReqMsg can accurately estimate
				// context pressure. Cost calculation still uses OpenAI semantic
				// (rawInputTokens includes cache) for correct provider billing.
				const nonCachedInputTokens = Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens)
				const totalCost = calculateApiCostOpenAI(
					modelInfo,
					rawInputTokens,
					outputTokens,
					cacheWriteTokens,
					cacheReadTokens,
				)

				yield {
					type: "usage",
					inputTokens: nonCachedInputTokens,
					outputTokens,
					cacheReadTokens,
					cacheWriteTokens,
					totalCost,
				}
			}

			const outputLimitError = getOpenAIChatOutputLimitError(chunk.choices?.[0]?.finish_reason)
			if (outputLimitError) {
				if (this.requestController === requestController) this.requestController = undefined
				throw outputLimitError
			}
		}
		if (this.requestController === requestController) this.requestController = undefined
	}

	private async createResponsesStream(
		client: OpenAI,
		params: OpenAI.Responses.ResponseCreateParamsStreaming,
		signal?: AbortSignal,
	) {
		try {
			return await client.responses.create(params, {
				signal,
				...(this.routingHeaders ? { headers: this.routingHeaders } : {}),
			})
		} catch (error) {
			const status =
				typeof error === "object" && error !== null && "status" in error
					? (error as { status?: unknown }).status
					: undefined
			if (typeof status !== "number" || status < 500 || signal?.aborted) {
				throw error
			}

			const retryDelay = 250
			this.ctx.onRetryAttempt?.(1, 2, retryDelay, error)
			await setTimeoutPromise(retryDelay, undefined, { signal })
			return await client.responses.create(params, {
				signal,
				...(this.routingHeaders ? { headers: this.routingHeaders } : {}),
			})
		}
	}

	private async *createResponsesMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		requestController: AbortController,
		tools?: ChatCompletionTool[],
		options?: ApiRequestOptions,
	): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const converted = convertToOpenAIResponsesInput(messages, {
			usePreviousResponseId: false,
			replayHostedTools: declaredResponsesHostedToolNames(options?.serverTools),
		})
		const hostedWebSearch = options?.serverTools?.includes(ServerTool.WEB_SEARCH) === true
		const input = converted.input
		const responseTools: OpenAI.Responses.Tool[] = (tools ?? [])
			.filter((tool): tool is ChatCompletionFunctionTool => tool.type === "function")
			.filter((tool) => !hostedWebSearch || tool.function.name !== "web_search")
			.map((tool) => ({
				type: "function" as const,
				name: tool.function.name,
				description: tool.function.description,
				parameters: tool.function.parameters ?? null,
				strict: tool.function.strict ?? true,
			}))
		if (hostedWebSearch) {
			responseTools.push({ type: "web_search" })
		}
		const reasoning = encodeOpenAIResponsesReasoning(model.info.capabilities, this.config?.reasoning)
		const reasoningEnabled = reasoning !== undefined && reasoning.effort !== "none"
		const temperature = model.info.capabilities?.temperature ?? this.config?.temperature
		const buildParams = (mode: OpenAIPromptCacheProjectionMode): OpenAI.Responses.ResponseCreateParamsStreaming => {
			const promptCache = projectOpenAIResponsesPromptCache({
				modelId: model.id,
				systemPrompt,
				input,
				tools: responseTools,
				taskNamespace: options?.taskNamespace,
				mode,
			})
			this.recordResponsesCompactionDiagnostic({
				requestKind: options?.generation?.purpose === "compaction" ? "compaction" : "ordinary",
				modelId: model.id,
				mode,
				taskNamespace: options?.taskNamespace,
				promptCacheKey: promptCache.promptCacheKey,
				instructions: promptCache.instructions,
				tools: responseTools,
				wireInput: promptCache.input,
			})
			return {
				model: model.id,
				...(promptCache.instructions === undefined ? {} : { instructions: promptCache.instructions }),
				input: promptCache.input,
				prompt_cache_key: promptCache.promptCacheKey,
				...(promptCache.promptCacheOptions ? { prompt_cache_options: promptCache.promptCacheOptions } : {}),
				stream: true,
				store: false,
				...(responseTools?.length ? { tools: responseTools } : {}),
				...(hostedWebSearch
					? { include: ["web_search_call.results" as const, "web_search_call.action.sources" as const] }
					: {}),
				...(this.serviceTier ? { service_tier: this.serviceTier } : {}),
				...(reasoning ? { reasoning } : {}),
				...(!reasoningEnabled && typeof temperature === "number" ? { temperature } : {}),
			}
		}

		const stream = await this.createWithPromptCacheFallback(this.promptCacheProjectionMode, (mode) =>
			this.createResponsesStream(client, buildParams(mode), requestController.signal),
		)
		const idleTimeoutSeconds = normalizeOpenAIResponsesStreamIdleTimeoutSeconds(this.config?.streamIdleTimeoutSeconds)
		const monitor = new OpenAIResponsesStreamMonitor({
			idleTimeoutMs: idleTimeoutSeconds * 1_000,
			abort: () => requestController.abort(),
			log: (message) => Logger.debug(message),
			requestLabel: this.ctx.ulid ? `Task ${this.ctx.ulid}` : "OpenAI",
			onEstimatedTokens: this.ctx.onStreamEstimatedTokens,
		})
		yield* handleResponsesApiStreamResponse(
			monitor.observe(stream),
			model.info,
			async (info, inputTokens, outputTokens, cacheWrite, cacheRead) =>
				calculateApiCostOpenAI(info, inputTokens, outputTokens, cacheWrite, cacheRead),
		)
	}

	abort(): void {
		this.requestController?.abort()
	}

	/** Used by the shared retry decorator to make backoff cancellation-aware. */
	getRetrySignal(): AbortSignal | undefined {
		return this.requestController?.signal
	}

	getModel(): { id: string; info: ModelInfo } {
		const info = this.buildModelInfo()
		return {
			id: this.modelId,
			info: prioritizeApiFormat(info, this.apiFormat),
		}
	}
}
