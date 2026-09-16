import { Anthropic } from "@anthropic-ai/sdk"
import { DeepSeekModelId, deepSeekDefaultModelId, deepSeekModels, ModelInfo } from "@shared/api"
import { providerFetch } from "@shared/net"
import { calculateApiCostOpenAI } from "@utils/cost"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { ClineError } from "@/services/error"
import { ClineStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { prioritizeApiFormat, resolveApiFormat } from "@/shared/providers/api-format"
import { Logger } from "@/shared/services/Logger"
import { resolveDeepSeekAdaptiveThinking } from "@/shared/utils/reasoning-support"
import { AccountUsage, ApiHandler, ApiHandlerContext, type ApiRequestOptions } from "../"
import { withRetry } from "../retry"
import { getOpenAIChatOutputLimitError } from "../stream/OutputLimitExceededError"
import { sanitizeAnthropicMessages } from "../transform/anthropic-format"
import {
	convertDeepSeekMessages,
	convertDeepSeekResponsesInput,
	convertDeepSeekResponsesTools,
	convertDeepseekToOpenAiMessages,
} from "../transform/deepseek-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { convertOpenAIToolsToAnthropicTools, handleAnthropicMessagesApiStreamResponse } from "../utils/messages_api_support"
import { handleResponsesApiStreamResponse } from "../utils/responses_api_support"

export class DeepSeekHandler implements ApiHandler {
	private client: OpenAI | undefined
	private anthropicClient: Anthropic | undefined
	private requestController: AbortController | undefined
	private accountUsageController: AbortController | undefined
	constructor(private ctx: ApiHandlerContext) {}

	getProviderId(): string {
		return this.ctx.profile.provider
	}

	private get config() {
		return this.ctx.profile.deepseek
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
	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.apiKey) {
				throw new Error("DeepSeek API key is required")
			}
			try {
				this.client = new OpenAI({
					baseURL: this.baseUrl || "https://api.deepseek.com",
					apiKey: this.apiKey,
					defaultHeaders: buildExternalBasicHeaders(),
					fetch: providerFetch,
					timeout: this.ctx.requestTimeoutMs,
					// Retry is handled by @withRetry so one logical request has one retry policy.
					maxRetries: 0,
				})
			} catch (error) {
				throw new Error(`Error creating DeepSeek client: ${error.message}`)
			}
		}
		return this.client
	}

	private getAnthropicBaseUrl(): string {
		const baseUrl = (this.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "")
		return baseUrl.endsWith("/anthropic") ? baseUrl : `${baseUrl}/anthropic`
	}

	private ensureAnthropicClient(): Anthropic {
		if (!this.anthropicClient) {
			if (!this.apiKey) {
				throw new Error("DeepSeek API key is required")
			}
			this.anthropicClient = new Anthropic({
				baseURL: this.getAnthropicBaseUrl(),
				apiKey: this.apiKey,
				defaultHeaders: buildExternalBasicHeaders(),
				fetch: providerFetch,
				timeout: this.ctx.requestTimeoutMs,
				maxRetries: 0,
			})
		}
		return this.anthropicClient
	}

	/** Expose the negotiated protocol so routing judges the same wire format. */
	getSelectedApiFormat(): ApiFormat {
		return resolveApiFormat(this.config?.apiFormat, this.getBaseModel().info, ApiFormat.OPENAI_CHAT)
	}

	supportsServerTool(tool: ServerTool): boolean {
		const apiFormat = this.getSelectedApiFormat()
		return (
			tool === ServerTool.WEB_SEARCH && (apiFormat === ApiFormat.OPENAI_RESPONSES || apiFormat === ApiFormat.ANTHROPIC_CHAT)
		)
	}

	private getThinkingSettings(model: { info: ModelInfo }) {
		const reasoning = this.config?.reasoning
		const adaptive = resolveDeepSeekAdaptiveThinking(reasoning?.effort)
		const configuredEnabled = reasoning?.enableThinking ?? (reasoning ? !!reasoning.effort : adaptive.enabled)
		return {
			enabled: (model.info.capabilities?.supportsReasoning ?? false) && configuredEnabled && adaptive.enabled,
			effort: adaptive.effort ?? "high",
		}
	}

	private async *yieldUsage(info: ModelInfo, usage: OpenAI.Completions.CompletionUsage | undefined): ApiStream {
		// Deepseek reports total input AND cache reads/writes,
		// see context caching: https://api-docs.deepseek.com/guides/kv_cache)
		// where the input tokens is the sum of the cache hits/misses, just like OpenAI.
		// This affects:
		// 1) context management truncation algorithm, and
		// 2) cost calculation

		// Deepseek usage includes extra fields.
		// Safely cast the prompt token details section to the appropriate structure.
		interface DeepSeekUsage extends OpenAI.CompletionUsage {
			prompt_cache_hit_tokens?: number
			prompt_cache_miss_tokens?: number
		}
		const deepUsage = usage as DeepSeekUsage

		const rawInputTokens = deepUsage?.prompt_tokens || 0 // sum of cache hits and misses
		const outputTokens = deepUsage?.completion_tokens || 0
		const cacheReadTokens = deepUsage?.prompt_cache_hit_tokens || 0
		const cacheWriteTokens = deepUsage?.prompt_cache_miss_tokens || 0
		const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens)
		const totalCost = calculateApiCostOpenAI(info, rawInputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
		yield {
			type: "usage",
			inputTokens: inputTokens,
			outputTokens: outputTokens,
			cacheWriteTokens: cacheWriteTokens,
			cacheReadTokens: cacheReadTokens,
			totalCost: totalCost,
		}
	}

	@withRetry()
	async *createMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: OpenAITool[],
		options?: ApiRequestOptions,
	): ApiStream {
		this.requestController?.abort()
		const requestController = new AbortController()
		this.requestController = requestController
		try {
			switch (this.getSelectedApiFormat()) {
				case ApiFormat.OPENAI_RESPONSES:
					yield* this.createResponsesMessage(systemPrompt, messages, tools, options, requestController.signal)
					break
				case ApiFormat.ANTHROPIC_CHAT:
					yield* this.createAnthropicMessage(systemPrompt, messages, tools, options, requestController.signal)
					break
				default:
					yield* this.createChatMessage(systemPrompt, messages, tools, options, requestController.signal)
			}
		} finally {
			if (this.requestController === requestController) {
				this.requestController = undefined
			}
		}
	}

	private async *createChatMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools: OpenAITool[] | undefined,
		options: ApiRequestOptions | undefined,
		signal: AbortSignal,
	): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const thinking = this.getThinkingSettings(model)
		const maxOutputTokens =
			options?.generation?.purpose === "compaction"
				? options.generation.maxOutputTokens
				: model.info.capabilities?.maxTokens

		const supportsReasoning = model.info.capabilities?.supportsReasoning ?? false

		// All deepseek models now use the same message conversion: V4-native format when thinking is on,
		// plain OpenAI format otherwise. deepseek-chat and deepseek-reasoner are deprecated as of 2026-07-24.
		// Only call the appropriate converter to avoid unnecessary warnings from skipping
		// pure-thinking messages in the non-thinking converter when thinking is actually enabled.
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = thinking.enabled
			? convertDeepSeekMessages(messages, systemPrompt)
			: [{ role: "system", content: systemPrompt }, ...convertDeepseekToOpenAiMessages(messages)]
		const stream = await client.chat.completions.create(
			{
				model: model.id,
				...(maxOutputTokens ? { max_completion_tokens: maxOutputTokens } : {}),
				messages: openAiMessages,
				stream: true,
				stream_options: { include_usage: true },
				...(supportsReasoning ? {} : { temperature: 0 }),
				...getOpenAIToolParams(tools),
				...(supportsReasoning
					? {
							extra_body: {
								thinking: { type: thinking.enabled ? "enabled" : "disabled" },
							},
							...(thinking.enabled ? { reasoning_effort: thinking.effort } : {}),
						}
					: {}),
			},
			{ signal },
		)

		const toolCallProcessor = new ToolCallProcessor()

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				if (thinking.enabled) {
					yield {
						type: "reasoning",
						reasoning: (delta.reasoning_content as string | undefined) || "",
					}
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			if (chunk.usage) {
				yield* this.yieldUsage(model.info, chunk.usage)
			}

			const outputLimitError = getOpenAIChatOutputLimitError(chunk.choices?.[0]?.finish_reason)
			if (outputLimitError) {
				throw outputLimitError
			}
		}
	}

	private async *createResponsesMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools: OpenAITool[] | undefined,
		options: ApiRequestOptions | undefined,
		signal: AbortSignal,
	): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const thinking = this.getThinkingSettings(model)
		const hostedWebSearch = options?.serverTools?.includes(ServerTool.WEB_SEARCH) === true
		const localTools = hostedWebSearch
			? tools?.filter((tool) => tool.type !== "function" || tool.function.name !== "web_search")
			: tools
		const responseTools: OpenAI.Responses.Tool[] = convertDeepSeekResponsesTools(localTools) ?? []
		if (hostedWebSearch) {
			responseTools.push({ type: "web_search" })
		}
		const maxOutputTokens =
			options?.generation?.purpose === "compaction"
				? options.generation.maxOutputTokens
				: model.info.capabilities?.maxTokens
		const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
			model: model.id,
			instructions: systemPrompt,
			input: convertDeepSeekResponsesInput(messages),
			stream: true,
			...(responseTools?.length ? { tools: responseTools } : {}),
			...(hostedWebSearch
				? { include: ["web_search_call.results" as const, "web_search_call.action.sources" as const] }
				: {}),
			...(thinking.enabled ? { reasoning: { effort: thinking.effort, summary: "auto" } } : {}),
			...(typeof maxOutputTokens === "number" && maxOutputTokens > 0 ? { max_output_tokens: maxOutputTokens } : {}),
		}
		const stream = await client.responses.create(params, { signal })
		yield* handleResponsesApiStreamResponse(
			stream,
			model.info,
			async (info, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens) =>
				calculateApiCostOpenAI(info, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens),
		)
	}

	private async *createAnthropicMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools: OpenAITool[] | undefined,
		options: ApiRequestOptions | undefined,
		signal: AbortSignal,
	): ApiStream {
		const client = this.ensureAnthropicClient()
		const model = this.getModel()
		const thinking = this.getThinkingSettings(model)
		const supportsPromptCache = model.info.capabilities?.supportsPromptCache ?? false
		const maxOutputTokens =
			options?.generation?.purpose === "compaction"
				? options.generation.maxOutputTokens
				: model.info.capabilities?.maxTokens
		const request = {
			model: model.id,
			max_tokens: maxOutputTokens ?? 8192,
			system: [
				{
					type: "text" as const,
					text: systemPrompt,
					...(supportsPromptCache ? { cache_control: { type: "ephemeral" as const } } : {}),
				},
			],
			messages: sanitizeAnthropicMessages(messages, supportsPromptCache),
			tools: convertOpenAIToolsToAnthropicTools(tools, options?.serverTools),
			stream: true as const,
			...(thinking.enabled
				? {
						thinking: { type: "adaptive" as const },
						output_config: { effort: thinking.effort },
					}
				: { temperature: 0 }),
		}
		const stream = await client.messages.create(request as Anthropic.MessageCreateParamsStreaming, { signal })
		yield* handleAnthropicMessagesApiStreamResponse(stream)
	}

	private getBaseModel(): { id: string; info: ModelInfo } {
		const modelId = this.modelId
		if (modelId && this.modelInfo) {
			return { id: modelId, info: this.modelInfo }
		}
		// Smooth migration from deprecated model names to v4-flash:
		// deepseek-chat → deepseek-v4-flash (non-thinking, reasoningEffort=none by default)
		// deepseek-reasoner → deepseek-v4-flash (thinking, existing reasoningEffort setting preserved)
		// Both now resolve to v4-flash; thinking is controlled solely by reasoningEffort.
		if (modelId && deepSeekModels[modelId]) {
			const id = modelId as DeepSeekModelId
			return { id, info: deepSeekModels[id] }
		}
		return {
			id: deepSeekDefaultModelId,
			info: deepSeekModels[deepSeekDefaultModelId],
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const model = this.getBaseModel()
		return {
			...model,
			info: prioritizeApiFormat(model.info, this.getSelectedApiFormat()),
		}
	}

	/**
	 * Query DeepSeek account balance + daily usage.
	 * Calls /user/balance for balance and /api/v0/usage/amount for daily tokens.
	 * Returns AccountUsage with balance breakdown and today's usage for the current model.
	 * @see https://api-docs.deepseek.com/zh-cn/api/get-user-balance
	 */
	async getAccountUsage(): Promise<AccountUsage | undefined> {
		if (!this.apiKey) {
			return undefined
		}
		this.accountUsageController?.abort()
		const accountUsageController = new AbortController()
		this.accountUsageController = accountUsageController
		const timeoutMs = Math.min(this.ctx.requestTimeoutMs ?? 15_000, 15_000)
		const timeout = setTimeout(() => accountUsageController.abort(), Math.max(1, timeoutMs))
		try {
			const headers = {
				Authorization: `Bearer ${this.apiKey}`,
				...buildExternalBasicHeaders(),
			}

			// Fetch balance
			const balanceResp = await fetch("https://api.deepseek.com/user/balance", {
				headers,
				signal: accountUsageController.signal,
			})
			if (!balanceResp.ok) {
				Logger.warn(`[DeepSeek] Balance API failed: ${balanceResp.status}`)
				return undefined
			}
			const balanceData = (await balanceResp.json()) as {
				is_available: boolean
				balance_infos: Array<{
					currency: string
					total_balance: string
					granted_balance: string
					topped_up_balance: string
				}>
			}
			const firstBalance = balanceData?.balance_infos?.[0]
			if (!firstBalance) {
				return undefined
			}

			// Fetch daily usage
			const now = new Date()
			const month = now.getMonth() + 1
			const year = now.getFullYear()
			const todayStr = `${year}-${String(month).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`

			let dailyInputTokens = 0
			let dailyOutputTokens = 0
			let dailyCacheHitTokens = 0
			let dailyCacheMissTokens = 0

			try {
				const usageResp = await fetch(`https://platform.deepseek.com/api/v0/usage/amount?month=${month}&year=${year}`, {
					headers,
					signal: accountUsageController.signal,
				})
				if (usageResp.ok) {
					const usageData = (await usageResp.json()) as {
						code: number
						data?: {
							biz_data?: {
								days?: Array<{
									date: string
									data?: Array<{
										model: string
										usage?: Array<{ type: string; amount: string }>
									}>
								}>
							}
						}
					}
					// Find today's data and match current model
					const today = usageData?.data?.biz_data?.days?.find((d) => d.date === todayStr)
					if (today?.data) {
						const model = this.getModel()
						const modelData = today.data.find((d) => d.model === model.id || d.model.includes("deepseek-v4")) // match current model or v4 family
						if (modelData?.usage) {
							for (const u of modelData.usage) {
								const amt = Number.parseInt(u.amount, 10) || 0
								switch (u.type) {
									case "PROMPT_CACHE_HIT_TOKEN":
										dailyCacheHitTokens += amt
										break
									case "PROMPT_CACHE_MISS_TOKEN":
										dailyCacheMissTokens += amt
										break
									case "RESPONSE_TOKEN":
										dailyOutputTokens += amt
										break
								}
							}
							dailyInputTokens = dailyCacheHitTokens + dailyCacheMissTokens
						}
					}
				} else {
					Logger.warn(`[DeepSeek] Usage API failed: ${usageResp.status}`)
				}
			} catch (e) {
				Logger.warn(`[DeepSeek] Usage API error: ${e}`)
			}

			return {
				currency: firstBalance.currency,
				remainingBalance: Number.parseFloat(firstBalance.total_balance),
				toppedUpBalance: Number.parseFloat(firstBalance.topped_up_balance),
				grantedBalance: Number.parseFloat(firstBalance.granted_balance),
				isAvailable: balanceData.is_available,
				dailyInputTokens,
				dailyOutputTokens,
				dailyCacheHitTokens,
				dailyCacheMissTokens,
			}
		} catch (e) {
			Logger.warn(`[DeepSeek] getAccountUsage error: ${e}`)
			return undefined
		} finally {
			clearTimeout(timeout)
			if (this.accountUsageController === accountUsageController) {
				this.accountUsageController = undefined
			}
		}
	}

	abort(): void {
		this.requestController?.abort()
		this.accountUsageController?.abort()
	}

	/** Used by the shared retry decorator to make backoff cancellation-aware. */
	getRetrySignal(): AbortSignal | undefined {
		return this.requestController?.signal
	}

	/**
	 * Parse DeepSeek-specific API errors into typed ClineError.
	 * Maps DeepSeek error codes (https://api-docs.deepseek.com/quick_start/error_codes):
	 *   402 → Balance (余额不足)
	 *   401 → Auth (认证失败)
	 *   429 → RateLimit (请求速率达到上限)
	 *   Other 4xx/5xx → falls back to generic ClineError.transform
	 * @param error Raw error from OpenAI SDK or fetch
	 * @param modelId Optional model identifier
	 * @returns ClineError with appropriate error type
	 */
	parseError(error: any, modelId?: string): ClineError {
		const status = error?.status || error?.statusCode || error?.response?.status
		const message = error?.message || String(error)

		if (status === 402) {
			return new ClineError(
				{
					code: "insufficient_credits",
					message: message || "DeepSeek 账户余额不足，请充值",
					status: 402,
					details: { current_balance: 0 },
				},
				modelId,
				"deepseek",
			)
		}

		if (status === 401) {
			return new ClineError(
				{
					code: "unauthorized",
					message: message || "DeepSeek API key 无效，请检查",
					status: 401,
				},
				modelId,
				"deepseek",
			)
		}

		if (status === 429) {
			return new ClineError(
				{
					code: "rate_limit_exceeded",
					message: message || "DeepSeek 请求速率达到上限，请稍后重试",
					status: 429,
				},
				modelId,
				"deepseek",
			)
		}

		// Fallback to generic error classification
		return ClineError.transform(error, modelId, "deepseek")
	}
}
