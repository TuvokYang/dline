// Restore GenerateContentConfig import and add GenerateContentResponseUsageMetadata
import {
	ApiError,
	FunctionCallingConfigMode,
	type GenerateContentConfig,
	type GenerateContentResponseUsageMetadata,
	GoogleGenAI,
	FunctionDeclaration as GoogleTool,
	ThinkingLevel,
} from "@google/genai"
import { GeminiModelId, geminiDefaultModelId, geminiModels, ModelInfo } from "@shared/api"
import { observeProviderStream } from "@shared/provider-attempt-observer"
import { resolveForcedToolUseSupport } from "@shared/utils/reasoning-support"
import { GEMINI_FLASH_MAX_OUTPUT_TOKENS, isGeminiFlashModel } from "@utils/model-utils"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { telemetryService } from "@/services/telemetry"
import { ClineStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { ApiHandler, ApiHandlerContext } from "../"
import { RetriableError, withRetry } from "../retry"
import { convertAnthropicMessageToGemini } from "../transform/gemini-format"
import { ApiStream } from "../transform/stream"

const rateLimitPatterns = [/got status: 429/i, /429 Too Many Requests/i, /rate limit exceeded/i, /too many requests/i]

function mapReasoningEffortToGeminiThinkingLevel(effort: string): ThinkingLevel {
	switch (effort) {
		case "low":
		case "medium":
			return ThinkingLevel.LOW
		case "high":
		case "xhigh":
			return ThinkingLevel.HIGH
		default:
			return ThinkingLevel.LOW
	}
}

function getGeminiMaxOutputTokens(modelId: string, modelMaxTokens?: number): number | undefined {
	if (!isGeminiFlashModel(modelId)) {
		return undefined
	}

	if (modelMaxTokens && modelMaxTokens > 0) {
		return Math.min(modelMaxTokens, GEMINI_FLASH_MAX_OUTPUT_TOKENS)
	}

	return GEMINI_FLASH_MAX_OUTPUT_TOKENS
}

export class GeminiHandler implements ApiHandler {
	private client: GoogleGenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.gemini
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

	private ensureClient(): GoogleGenAI {
		if (!this.client) {
			const externalHeaders = buildExternalBasicHeaders()

			if (this.ctx.profile.provider === "vertex") {
				const project = "not-provided"
				const location = "not-provided"

				try {
					this.client = new GoogleGenAI({
						vertexai: true,
						project,
						location,
						httpOptions: {
							headers: externalHeaders,
						},
					})
				} catch (error) {
					throw new Error(`Error creating Gemini Vertex AI client: ${error.message}`)
				}
			} else {
				if (!this.apiKey) {
					throw new Error("API key is required for Google Gemini when not using Vertex AI")
				}

				try {
					this.client = new GoogleGenAI({
						apiKey: this.apiKey,
						httpOptions: {
							headers: externalHeaders,
						},
					})
				} catch (error) {
					throw new Error(`Error creating Gemini client: ${error.message}`)
				}
			}
		}
		return this.client
	}

	@withRetry({
		maxRetries: 4,
		baseDelay: 2000,
		maxDelay: 15000,
	})
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: GoogleTool[]): ApiStream {
		const client = this.ensureClient()
		const { id: modelId, info } = this.getModel()
		const contents = messages.map(convertAnthropicMessageToGemini)
		const responseToolCallCount = new Map<string, number>()

		const _thinkingBudget = this.thinkingBudgetTokens
		const maxBudget = info.capabilities?.thinking?.maxBudget ?? 24576
		const thinkingBudget = Math.min(_thinkingBudget, maxBudget)
		let thinkingLevel: ThinkingLevel | undefined
		const rawReasoningEffort = (this.reasoningEffort || "").toLowerCase()
		const normalizedReasoningEffort = !rawReasoningEffort || rawReasoningEffort === "none" ? "low" : rawReasoningEffort
		if (info.capabilities?.thinking?.effortLevels) {
			thinkingLevel = mapReasoningEffortToGeminiThinkingLevel(normalizedReasoningEffort)
		}

		const maxOutputTokens = getGeminiMaxOutputTokens(modelId, info.capabilities?.maxTokens)
		const requestConfig: GenerateContentConfig = {
			httpOptions: this.baseUrl ? { baseUrl: this.baseUrl } : undefined,
			systemInstruction: systemPrompt,
			temperature: 1,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		}

		if (info.capabilities?.thinking) {
			;(requestConfig as any).thinkingConfig = {
				thinkingBudget: thinkingLevel ? undefined : thinkingBudget,
				thinkingLevel,
				includeThoughts: thinkingBudget > 0 || !!thinkingLevel,
			}
		}

		const sdkCallStartTime = Date.now()
		let responseId: string | undefined
		let sdkFirstChunkTime: number | undefined
		let ttftSdkMs: number | undefined
		let apiSuccess = false
		let apiError: string | undefined
		let promptTokens = 0
		let outputTokens = 0
		let cacheReadTokens = 0
		let thoughtsTokenCount = 0
		let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined

		const isNativeToolCallsEnabled = tools?.length
		if (isNativeToolCallsEnabled) {
			requestConfig.tools = [{ functionDeclarations: tools }]
			// Gemini accepts a forced call by default, so this stays ANY unless the
			// model declares otherwise. Reading the declaration keeps one catalog
			// entry able to opt out without the request ignoring it.
			requestConfig.toolConfig = {
				functionCallingConfig: {
					mode: resolveForcedToolUseSupport(modelId, info.capabilities)
						? FunctionCallingConfigMode.ANY
						: FunctionCallingConfigMode.AUTO,
				},
			}
		}

		try {
			const result = await observeProviderStream(() =>
				client.models.generateContentStream({
					model: modelId,
					contents: contents,
					config: { ...requestConfig },
				}),
			)

			let isFirstSdkChunk = true
			for await (const chunk of result) {
				const responseKey = chunk.responseId || "gemini-response"
				if (isFirstSdkChunk) {
					sdkFirstChunkTime = Date.now()
					ttftSdkMs = sdkFirstChunkTime - sdkCallStartTime
					isFirstSdkChunk = false
				}

				const parts = chunk?.candidates?.[0]?.content?.parts || []
				for (const part of parts) {
					if (part.thought && part.text) {
						yield {
							type: "reasoning",
							provider_metadata: { response_id: chunk.responseId },
							reasoning: part.text || "",
							signature: part.thoughtSignature,
						}
					} else if (part.text) {
						yield {
							type: "text",
							text: part.text,
							provider_metadata: { response_id: chunk.responseId },
							signature: part.thoughtSignature,
						}
					}
					if (part.functionCall) {
						const functionCall = part.functionCall
						const args = Object.entries(functionCall.args || {}).filter(([_key, val]) => !!val)
						if (functionCall.args && args.length > 0) {
							const existingId = functionCall.id?.trim()
							const toolCallId =
								existingId ??
								(() => {
									const sequenceNumber = responseToolCallCount.get(responseKey) ?? 0
									responseToolCallCount.set(responseKey, sequenceNumber + 1)
									return `${responseKey}-tool-${sequenceNumber}`
								})()
							yield {
								type: "tool_calls",
								function_id: toolCallId,
								argumentsMode: "snapshot",
								provider_metadata: { response_id: chunk.responseId },
								tool_call: {
									function: {
										name: functionCall.name,
										arguments: JSON.stringify(functionCall.args),
									},
								},
								signature: part.thoughtSignature,
							}
						}
					}
				}

				if (chunk.usageMetadata) {
					const usageMetadata = chunk.usageMetadata
					responseId = chunk.responseId
					lastUsageMetadata = usageMetadata
					promptTokens = usageMetadata.promptTokenCount ?? promptTokens
					outputTokens = usageMetadata.candidatesTokenCount ?? outputTokens
					thoughtsTokenCount = usageMetadata.thoughtsTokenCount ?? thoughtsTokenCount
					cacheReadTokens = usageMetadata.cachedContentTokenCount ?? cacheReadTokens
				}
			}
			apiSuccess = true

			if (lastUsageMetadata) {
				const totalCost = this.calculateCost({
					info,
					inputTokens: promptTokens,
					outputTokens,
					thoughtsTokenCount,
					cacheReadTokens,
				})
				yield {
					type: "usage",
					inputTokens: promptTokens - cacheReadTokens,
					outputTokens,
					thoughtsTokenCount,
					cacheReadTokens,
					cacheWriteTokens: 0,
					totalCost,
					provider_metadata: responseId ? { response_id: responseId } : undefined,
				}
			}
		} catch (error) {
			apiSuccess = false
			if (error instanceof Error) {
				apiError = error.message
				if (error instanceof ApiError) {
					if (error.status === 429) {
						const response = this.attemptParse(error.message)
						if (response?.error) {
							const responseBody = this.attemptParse(response.error.message)
							if (responseBody.error) {
								const detail = responseBody.error.details?.find(
									(d: any) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
								)
								const detailedError = new RetriableError(
									apiError,
									this.parseRetryDelay(detail?.retryDelay) || undefined,
									{ cause: error },
								)
								throw detailedError
							}
						}
						throw new RetriableError(apiError, undefined, { cause: error })
					}
					const isRateLimit = rateLimitPatterns.some((pattern) => pattern.test(error.message))
					if (isRateLimit) {
						throw new RetriableError(apiError, undefined, { cause: error })
					}
				}
			} else {
				apiError = String(error)
			}
			throw error
		} finally {
			const sdkCallEndTime = Date.now()
			const totalDurationSdkMs = sdkCallEndTime - sdkCallStartTime
			const cacheHit = cacheReadTokens > 0
			const cacheHitPercentage = promptTokens > 0 ? (cacheReadTokens / promptTokens) * 100 : undefined
			const throughputTokensPerSecSdk =
				totalDurationSdkMs > 0 && outputTokens > 0 ? outputTokens / (totalDurationSdkMs / 1000) : undefined

			if (this.ctx.ulid) {
				telemetryService.captureGeminiApiPerformance(this.ctx.ulid, modelId, {
					ttftSec: ttftSdkMs !== undefined ? ttftSdkMs / 1000 : undefined,
					totalDurationSec: totalDurationSdkMs / 1000,
					promptTokens,
					outputTokens,
					cacheReadTokens,
					cacheHit,
					cacheHitPercentage,
					apiSuccess,
					apiError,
					throughputTokensPerSec: throughputTokensPerSecSdk,
				})
			} else {
				Logger.warn("GeminiHandler: ulid not available for telemetry in createMessage.")
			}
		}
	}

	public calculateCost({
		info,
		inputTokens,
		outputTokens,
		thoughtsTokenCount = 0,
		cacheReadTokens = 0,
	}: {
		info: ModelInfo
		inputTokens: number
		outputTokens: number
		thoughtsTokenCount: number
		cacheReadTokens?: number
	}) {
		if (!info.pricing?.inputPrice || !info.pricing?.outputPrice) {
			return undefined
		}

		let inputPrice = info.pricing?.inputPrice
		let outputPrice = info.pricing?.outputPrice
		let cacheReadsPrice = info.pricing?.cacheReadsPrice ?? 0

		if (info.pricing?.tiers) {
			const tier = info.pricing?.tiers.find((tier) => inputTokens <= tier.contextWindow)
			if (tier) {
				inputPrice = tier.inputPrice ?? inputPrice
				outputPrice = tier.outputPrice ?? outputPrice
				cacheReadsPrice = tier.cacheReadsPrice ?? cacheReadsPrice
			}
		}

		const uncachedInputTokens = inputTokens - (cacheReadTokens ?? 0)
		const inputTokensCost = inputPrice * (uncachedInputTokens / 1_000_000)
		const responseTokensCost = outputPrice * ((outputTokens + thoughtsTokenCount) / 1_000_000)
		const cacheReadCost = (cacheReadTokens ?? 0) > 0 ? cacheReadsPrice * ((cacheReadTokens ?? 0) / 1_000_000) : 0
		const totalCost = inputTokensCost + responseTokensCost + cacheReadCost

		return totalCost
	}

	getModel(): { id: GeminiModelId; info: ModelInfo } {
		const mId = this.modelId
		if (mId && mId in geminiModels) {
			const id = mId as GeminiModelId
			return { id, info: geminiModels[id] }
		}
		return { id: geminiDefaultModelId, info: geminiModels[geminiDefaultModelId] }
	}

	async countTokens(content: Array<any>): Promise<number> {
		try {
			const client = this.ensureClient()
			const { id: model } = this.getModel()
			const geminiContent = content.map((block) => {
				if (typeof block === "string") return { text: block }
				return { text: JSON.stringify(block) }
			})
			const response = await client.models.countTokens({ model, contents: [{ parts: geminiContent }] })
			if (response.totalTokens === undefined) {
				Logger.warn("Gemini token counting returned undefined, using fallback")
				return this.estimateTokens(content)
			}
			return response.totalTokens
		} catch (error) {
			Logger.warn("Gemini token counting failed, using fallback", error)
			return this.estimateTokens(content)
		}
	}

	private estimateTokens(content: Array<any>): number {
		const totalChars = content.reduce((total, block) => {
			if (typeof block === "string") return total + block.length
			if (block && typeof block === "object") {
				try {
					const jsonStr = JSON.stringify(block)
					return total + jsonStr.length
				} catch (e) {
					Logger.warn("Failed to stringify block for token estimation", e)
					return total
				}
			}
			return total
		}, 0)
		return Math.ceil(totalChars / 4)
	}

	private parseRetryDelay(retryAfter?: string): number {
		if (!retryAfter) return 0
		const unit = retryAfter.at(-1)
		const value = Number.parseInt(retryAfter, 10)
		if (Number.isNaN(value)) return 0
		if (unit === "s") return value
		if (unit === "m") return value * 60
		if (unit === "h") return value * 60 * 60
		return value
	}

	private attemptParse(str: string) {
		try {
			return JSON.parse(str)
		} catch (_) {
			return null
		}
	}
}
