import { Anthropic, APIError as AnthropicAPIError } from "@anthropic-ai/sdk"
import { liteLlmDefaultModelId, ModelInfo } from "@shared/api"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { resolveProfileModelId } from "@shared/providers/profile-model-info"
import OpenAI, { APIError as OpenAIAPIError, OpenAIError } from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import {
	DEFAULT_EXTERNAL_OCA_BASE_URL,
	DEFAULT_INTERNAL_OCA_BASE_URL,
	OCI_HEADER_OPC_REQUEST_ID,
} from "@/services/auth/oca/utils/constants"
import { createOcaHeaders } from "@/services/auth/oca/utils/utils"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { OcaModelInfo } from "@/shared/api"
import { ClineStorageMessage } from "@/shared/messages/content"
import { fetch, providerFetch } from "@/shared/net"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { Logger } from "@/shared/services/Logger"
import { ApiHandler, type ApiHandlerContext, type ApiRequestOptions } from ".."
import { withRetry } from "../retry"
import { getOpenAIChatOutputLimitError } from "../stream/OutputLimitExceededError"
import { sanitizeAnthropicMessages } from "../transform/anthropic-format"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToOpenAIResponsesInput } from "../transform/openai-response-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { convertOpenAIToolsToAnthropicTools, handleAnthropicMessagesApiStreamResponse } from "../utils/messages_api_support"
import { handleResponsesApiStreamResponse } from "../utils/responses_api_support"
import { resolveAnthropicReasoning } from "./anthropic/reasoning"
import { encodeOpenAIResponsesReasoning, resolveOpenAIReasoning, resolveOpenAIReasoningEffort } from "./openai/reasoning"

export class OcaHandler implements ApiHandler {
	protected openAIClient: OpenAI | undefined
	protected anthropicClient: Anthropic | undefined
	protected externalHeaders: Record<string, string> = {}
	private costRatesPromise: Promise<{ inputCostPerMillion: number; outputCostPerMillion: number }> | undefined

	constructor(protected ctx: ApiHandlerContext) {}

	protected get config() {
		return this.ctx.profile.oca
	}
	protected get apiKey() {
		return this.ctx.profile.apiKey
	}
	protected get modelId() {
		return resolveProfileModelId(this.ctx.profile)
	}
	protected get modelInfo() {
		return this.ctx.profile.modelInfo as OcaModelInfo | undefined
	}
	protected get baseUrl() {
		return this.ctx.profile.baseUrl
	}

	protected initializeOpenAIClient(): OpenAI {
		const externalHeaders = buildExternalBasicHeaders()
		const ulid = this.ctx.ulid
		return new (class OCIOpenAI extends OpenAI {
			protected override async prepareOptions(opts: any): Promise<void> {
				const token = await OcaAuthService.getInstance().getAuthToken()
				if (!token) {
					throw new OpenAIError("Unable to handle auth, Oracle Code Assist (OCA) access token is not available")
				}
				opts.headers ??= {}
				// OCA Headers
				const ociHeaders = await createOcaHeaders(token, ulid!)
				opts.headers = { ...opts.headers, ...externalHeaders, ...ociHeaders }
				Logger.log(`Making request with customer opc-request-id: ${opts.headers?.["opc-request-id"]}`)
				return super.prepareOptions(opts)
			}

			protected override makeStatusError(
				status: number | undefined,
				error: Object | undefined,
				message: string | undefined,
				headers: any | undefined,
			): OpenAIAPIError {
				interface OciError {
					code?: string
					message?: string
				}
				let ociErrorMessage = message
				if (typeof error === "object" && error !== null) {
					try {
						ociErrorMessage = JSON.stringify(error)
						const ociErr = error as OciError
						if (ociErr.code !== undefined && ociErr.message !== undefined) {
							ociErrorMessage = `${ociErr.code}: ${ociErr.message}`
						}
					} catch {}
				}
				const opcRequestId = headers?.[OCI_HEADER_OPC_REQUEST_ID]
				if (opcRequestId) {
					ociErrorMessage += `\n(${OCI_HEADER_OPC_REQUEST_ID}: ${opcRequestId})`
				}
				const statusCode = typeof status === "number" ? status : 500
				return super.makeStatusError(statusCode, error ?? {}, ociErrorMessage, headers)
			}
		})({
			baseURL:
				this.baseUrl ||
				(this.config?.ocaMode === "internal" ? DEFAULT_INTERNAL_OCA_BASE_URL : DEFAULT_EXTERNAL_OCA_BASE_URL),
			apiKey: "noop",
			fetch: providerFetch,
		})
	}

	protected initializeAnthropicClient(): Anthropic {
		const externalHeaders = buildExternalBasicHeaders()
		const ulid = this.ctx.ulid
		return new (class OCIAnthropic extends Anthropic {
			protected override async prepareOptions(opts: any): Promise<void> {
				const token = await OcaAuthService.getInstance().getAuthToken()
				if (!token) {
					throw new OpenAIError("Unable to handle auth, Oracle Code Assist (OCA) access token is not available")
				}
				opts.headers ??= {}
				// OCA Headers
				const ociHeaders = await createOcaHeaders(token, ulid!)
				opts.headers = { ...opts.headers, ...externalHeaders, ...ociHeaders }
				Logger.log(`Making request with customer opc-request-id: ${opts.headers?.["opc-request-id"]}`)
				return super.prepareOptions(opts)
			}

			protected override makeStatusError(
				status: number | undefined,
				error: Object | undefined,
				message: string | undefined,
				headers: any | undefined,
			): AnthropicAPIError {
				interface OciError {
					code?: string
					message?: string
				}
				let ociErrorMessage = message
				if (typeof error === "object" && error !== null) {
					try {
						ociErrorMessage = JSON.stringify(error)
						const ociErr = error as OciError
						if (ociErr.code !== undefined && ociErr.message !== undefined) {
							ociErrorMessage = `${ociErr.code}: ${ociErr.message}`
						}
					} catch {}
				}
				const opcRequestId = headers?.[OCI_HEADER_OPC_REQUEST_ID]
				if (opcRequestId) {
					ociErrorMessage += `\n(${OCI_HEADER_OPC_REQUEST_ID}: ${opcRequestId})`
				}
				const statusCode = typeof status === "number" ? status : 500
				return super.makeStatusError(statusCode, error ?? {}, ociErrorMessage, headers)
			}
		})({
			baseURL:
				this.baseUrl ||
				(this.config?.ocaMode === "internal" ? DEFAULT_INTERNAL_OCA_BASE_URL : DEFAULT_EXTERNAL_OCA_BASE_URL),
			apiKey: "noop",
			fetch: providerFetch,
		})
	}

	protected ensureOpenAIClient(): OpenAI {
		if (!this.openAIClient) {
			if (!this.modelId) {
				throw new Error("Oracle Code Assist (OCA) model is not selected")
			}
			try {
				this.openAIClient = this.initializeOpenAIClient()
			} catch (error) {
				throw new Error(`Error creating Oracle Code Assist (OCA) client: ${error.message}`)
			}
		}
		return this.openAIClient
	}

	protected ensureAnthropicClient(): Anthropic {
		if (!this.anthropicClient) {
			if (!this.modelId) {
				throw new Error("Oracle Code Assist (OCA) model is not selected")
			}
			try {
				this.anthropicClient = this.initializeAnthropicClient()
			} catch (error) {
				throw new Error(`Error creating Oracle Code Assist (OCA) client: ${error.message}`)
			}
		}
		return this.anthropicClient
	}

	async getApiCosts(prompt_tokens: number, completion_tokens: number): Promise<number | undefined> {
		// Reference: https://github.com/BerriAI/litellm/blob/122ee634f434014267af104814022af1d9a0882f/litellm/proxy/spend_tracking/spend_management_endpoints.py#L1473
		const client = this.ensureOpenAIClient()
		const modelId = this.modelId || liteLlmDefaultModelId
		const token = await OcaAuthService.getInstance().getAuthToken()
		if (!token) {
			throw new OpenAIError("Unable to handle auth, Oracle Code Assist (OCA) access token is not available")
		}
		const externalHeaders = buildExternalBasicHeaders()
		const ociHeaders = await createOcaHeaders(token, this.ctx.ulid!)
		Logger.log(`Making calculate cost request with customer opc-request-id: ${ociHeaders["opc-request-id"]}`)
		try {
			const response = await fetch(`${client.baseURL}/spend/calculate`, {
				method: "POST",
				headers: { ...externalHeaders, ...ociHeaders },
				body: JSON.stringify({
					completion_response: {
						model: modelId,
						usage: {
							prompt_tokens,
							completion_tokens,
						},
					},
				}),
			})

			if (response.ok) {
				const data: { cost: number } = await response.json()
				return data.cost
			}
			Logger.error("Error calculating spend:", response.statusText)
			return undefined
		} catch (error) {
			Logger.error("Error calculating spend:", error)
			return undefined
		}
	}

	async calculateCost(
		_modelInfo: ModelInfo,
		inputTokens: number,
		outputTokens: number,
		_cacheWriteTokens?: number,
		_cacheReadTokens?: number,
	) {
		const { inputCostPerMillion, outputCostPerMillion } = await this.getCostRates()
		return (inputCostPerMillion * inputTokens) / 1e6 + (outputCostPerMillion * outputTokens) / 1e6
	}

	private getCostRates(): Promise<{ inputCostPerMillion: number; outputCostPerMillion: number }> {
		this.costRatesPromise ??= Promise.all([this.getApiCosts(1e6, 0), this.getApiCosts(0, 1e6)]).then(
			([inputCost, outputCost]) => ({
				inputCostPerMillion: inputCost ?? 0,
				outputCostPerMillion: outputCost ?? 0,
			}),
		)
		return this.costRatesPromise
	}

	supportsServerTool(tool: ServerTool): boolean {
		const apiFormat = this.modelInfo?.apiFormats?.[0]
		return (
			tool === ServerTool.WEB_SEARCH && (apiFormat === ApiFormat.OPENAI_RESPONSES || apiFormat === ApiFormat.ANTHROPIC_CHAT)
		)
	}

	@withRetry()
	async *createMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: OpenAITool[],
		options?: ApiRequestOptions,
	): ApiStream {
		const apiFormat = this.modelInfo?.apiFormats?.[0]
		if (apiFormat === ApiFormat.OPENAI_RESPONSES) {
			yield* this.createMessageResponsesApi(systemPrompt, messages, tools, options)
		} else if (apiFormat === ApiFormat.ANTHROPIC_CHAT) {
			yield* this.createMessageMessagesApi(systemPrompt, messages, tools, options)
		} else {
			yield* this.createMessageChatApi(systemPrompt, messages, tools, options)
		}
	}

	async *createMessageChatApi(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: OpenAITool[],
		options?: ApiRequestOptions,
	): ApiStream {
		const client = this.ensureOpenAIClient()
		const formattedMessages = convertToOpenAiMessages(messages)
		const systemMessage: OpenAI.Chat.ChatCompletionSystemMessageParam = {
			role: "system",
			content: systemPrompt,
		}
		const modelId = this.modelId || liteLlmDefaultModelId
		const isOminiModel = modelId.includes("o1-mini") || modelId.includes("o3-mini") || modelId.includes("o4-mini")

		const capabilities = this.getModel().info.capabilities
		const manualThinking =
			capabilities?.thinking?.mode === "budget"
				? resolveAnthropicReasoning(capabilities, this.config?.reasoning)
				: undefined
		const effort = resolveOpenAIReasoningEffort(capabilities, this.config?.reasoning)
		const reasoningOn =
			manualThinking?.enabled === true ||
			(capabilities?.thinking?.mode === "effort" && resolveOpenAIReasoning(capabilities, this.config?.reasoning).enabled)

		let temperature: number | undefined = this.modelInfo?.temperature ?? 0
		const maxTokens: number | undefined =
			options?.generation?.purpose === "compaction"
				? options.generation.maxOutputTokens
				: this.modelInfo?.capabilities?.maxTokens

		if (isOminiModel && reasoningOn) {
			temperature = undefined // Thinking mode doesn't support temperature
		}

		// Define cache control object if prompt caching is enabled
		const cacheControl = this.modelInfo?.capabilities?.supportsPromptCache
			? { cache_control: { type: "ephemeral" } }
			: undefined

		// Add cache_control to system message if enabled
		const enhancedSystemMessage = {
			...systemMessage,
			...(cacheControl && cacheControl),
		}

		// Find the last two user messages to apply caching
		const userMsgIndices = formattedMessages.reduce((acc, msg, index) => {
			if (msg.role === "user") {
				acc.push(index)
			}
			return acc
		}, [] as number[])
		const lastUserMsgIndex = userMsgIndices[userMsgIndices.length - 1] ?? -1
		const secondLastUserMsgIndex = userMsgIndices[userMsgIndices.length - 2] ?? -1

		// Apply cache_control to the last two user messages if enabled
		const enhancedMessages = formattedMessages.map((message, index) => {
			if ((index === lastUserMsgIndex || index === secondLastUserMsgIndex) && cacheControl) {
				return {
					...message,
					...cacheControl,
				}
			}
			return message
		})

		const toolCallProcessor = new ToolCallProcessor()

		const chatCompletionsParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
			model: this.modelId || liteLlmDefaultModelId,
			messages: [enhancedSystemMessage, ...enhancedMessages],
			temperature,
			stream: true,
			max_completion_tokens: maxTokens,
			max_tokens: maxTokens,
			stream_options: { include_usage: true },
			...(manualThinking?.thinking && { thinking: manualThinking.thinking }),
			...(this.ctx.ulid && {
				litellm_session_id: `cline-${this.ctx.ulid}`,
				...getOpenAIToolParams(tools),
			}), // Add session ID for LiteLLM tracking
		}

		if (effort !== undefined) chatCompletionsParams.reasoning_effort = effort

		await this.getCostRates()
		const stream = await client.chat.completions.create(chatCompletionsParams)

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta

			// Handle normal text content
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			// Handle reasoning events (thinking)
			// Thinking is not in the standard types but may be in the response
			interface ThinkingDelta {
				thinking?: string
			}

			if ((delta as ThinkingDelta)?.thinking) {
				yield {
					type: "reasoning",
					reasoning: (delta as ThinkingDelta).thinking || "",
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			// Handle token usage information
			if (chunk.usage) {
				const totalCost = await this.calculateCost(
					this.modelInfo!,
					chunk.usage.prompt_tokens,
					chunk.usage.completion_tokens,
				)

				// Extract cache-related information if available
				// Need to use type assertion since these properties are not in the standard OpenAI types
				const usage = chunk.usage as {
					prompt_tokens: number
					completion_tokens: number
					cache_creation_input_tokens?: number
					prompt_cache_miss_tokens?: number
					cache_read_input_tokens?: number
					prompt_cache_hit_tokens?: number
				}

				const cacheWriteTokens = usage.cache_creation_input_tokens || usage.prompt_cache_miss_tokens || 0
				const cacheReadTokens = usage.cache_read_input_tokens || usage.prompt_cache_hit_tokens || 0

				yield {
					type: "usage",
					inputTokens: usage.prompt_tokens || 0,
					outputTokens: usage.completion_tokens || 0,
					cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : undefined,
					cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
					totalCost,
				}
			}

			const outputLimitError = getOpenAIChatOutputLimitError(chunk.choices?.[0]?.finish_reason)
			if (outputLimitError) {
				throw outputLimitError
			}
		}
	}

	async *createMessageResponsesApi(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: OpenAITool[],
		options?: ApiRequestOptions,
	): ApiStream {
		const client = this.ensureOpenAIClient()
		const inputMessages = convertToOpenAIResponsesInput(messages, { usePreviousResponseId: false }).input
		// Convert messages to Responses API input format
		const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "system", content: systemPrompt }, ...inputMessages]

		// Convert ChatCompletion tools to Responses API format if provided
		const hostedWebSearch = options?.serverTools?.includes(ServerTool.WEB_SEARCH) === true
		const responseTools: OpenAI.Responses.Tool[] = (tools ?? [])
			.filter((tool) => tool?.type === "function")
			.filter((tool) => !hostedWebSearch || tool.function.name !== "web_search")
			.map((tool: any) => ({
				type: "function" as const,
				name: tool.function.name,
				description: tool.function.description,
				parameters: tool.function.parameters,
				strict: tool.function.strict ?? true, // Responses API defaults to strict mode
			}))
		if (hostedWebSearch) {
			responseTools.push({ type: "web_search" })
		}

		let temperature: number | undefined = this.modelInfo?.temperature ?? 0
		const maxOutputTokens: number | undefined =
			options?.generation?.purpose === "compaction"
				? options.generation.maxOutputTokens
				: this.modelInfo?.capabilities?.maxTokens

		const ocaModelInfo = this.modelInfo
		if (!ocaModelInfo) {
			throw new Error("Oracle Code Assist (OCA) model info is required for Responses API")
		}

		const reasoning = encodeOpenAIResponsesReasoning(this.getModel().info.capabilities, this.config?.reasoning)
		const reasoningOn = reasoning !== undefined && reasoning.effort !== "none"
		if (reasoningOn) {
			temperature = undefined
		}

		const responsesParams: OpenAI.Responses.ResponseCreateParamsStreaming = {
			model: this.modelId || liteLlmDefaultModelId,
			input,
			stream: true,
			tools: responseTools.length > 0 ? responseTools : undefined,
			...(hostedWebSearch
				? { include: ["web_search_call.results" as const, "web_search_call.action.sources" as const] }
				: {}),
			...(typeof temperature === "number" ? { temperature } : {}),
			...(typeof maxOutputTokens === "number" && maxOutputTokens > 0 ? { max_output_tokens: maxOutputTokens } : {}),
		}

		if (reasoning !== undefined) responsesParams.reasoning = reasoning

		// Resolve management-plane pricing before the observed model send begins.
		await this.getCostRates()
		const stream = await client.responses.create(responsesParams)

		yield* handleResponsesApiStreamResponse(stream, ocaModelInfo, this.calculateCost.bind(this))
	}

	async *createMessageMessagesApi(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: OpenAITool[],
		options?: ApiRequestOptions,
	): ApiStream {
		const client = this.ensureAnthropicClient()

		const modelId = this.modelId || liteLlmDefaultModelId

		const reasoning = resolveAnthropicReasoning(this.getModel().info.capabilities, this.config?.reasoning)
		const reasoningOn = reasoning.enabled

		let temperature: number | undefined = this.modelInfo?.temperature ?? 0
		const maxTokens: number | undefined =
			options?.generation?.purpose === "compaction"
				? options.generation.maxOutputTokens
				: this.modelInfo?.capabilities?.maxTokens || 8192

		if (reasoningOn) {
			temperature = 0
		}

		const anthropicTools = convertOpenAIToolsToAnthropicTools(tools, options?.serverTools)
		const anthropicMessages = sanitizeAnthropicMessages(messages, this.modelInfo?.capabilities?.supportsPromptCache ?? false)

		const stream = await client.messages.create({
			model: modelId,
			max_tokens: maxTokens,
			temperature: reasoningOn ? undefined : temperature,
			system: [
				{
					text: systemPrompt,
					type: "text",
					cache_control: this.modelInfo?.capabilities?.supportsPromptCache ? { type: "ephemeral" } : undefined,
				},
			],
			messages: anthropicMessages,
			stream: true,
			tools: anthropicTools,
			thinking: reasoning.thinking,
			...(reasoning.outputConfig ? { output_config: reasoning.outputConfig } : {}),
		})

		yield* handleAnthropicMessagesApiStreamResponse(stream)
	}

	getModel() {
		const id = this.modelId || liteLlmDefaultModelId
		const baseModel = this.modelInfo?.id === id ? this.modelInfo : undefined
		return {
			id,
			info: buildEffectiveModelInfo(id, baseModel, {
				capabilities: this.config?.capabilities,
				pricing: this.config?.pricing,
			}),
		}
	}
}
