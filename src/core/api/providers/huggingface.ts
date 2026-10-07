import { huggingFaceDefaultModelId, huggingFaceModels, ModelInfo } from "@shared/api"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import { calculateApiCostOpenAI } from "@utils/cost"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiHandler, ApiHandlerContext } from "../"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

export class HuggingFaceHandler implements ApiHandler {
	private client: OpenAI | undefined
	private cachedModel: { id: string; info: ModelInfo } | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.huggingface
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
				throw new Error("Hugging Face API key is required")
			}

			try {
				this.client = createOpenAIClient({
					baseURL: this.baseUrl || "https://router.huggingface.co/v1",
					apiKey: this.apiKey,
				})
			} catch (error: any) {
				throw new Error(`Error creating Hugging Face client: ${error.message}`)
			}
		}
		return this.client
	}

	private async *yieldUsage(info: ModelInfo, usage: OpenAI.Completions.CompletionUsage | undefined): ApiStream {
		if (!usage) {
			return
		}

		const inputTokens = usage.prompt_tokens || 0
		const outputTokens = usage.completion_tokens || 0
		const totalCost = calculateApiCostOpenAI(info, inputTokens, outputTokens)

		const usageData = {
			type: "usage" as const,
			inputTokens: inputTokens,
			outputTokens: outputTokens,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalCost: totalCost,
		}

		yield usageData
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		const requestParams = {
			model: model.id,
			max_tokens: model.info.capabilities?.maxTokens,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			temperature: 0,
			...getOpenAIToolParams(tools),
		}

		const toolCallProcessor = new ToolCallProcessor()
		const stream = (await client.chat.completions.create(requestParams)) as any

		let _chunkCount = 0
		let _totalContent = ""

		for await (const chunk of stream) {
			_chunkCount++
			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) {
				_totalContent += delta.content

				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			if (chunk.usage) {
				yield* this.yieldUsage(model.info, chunk.usage)
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		this.cachedModel ??= resolveRuntimeModel(this.ctx.profile, {
			models: huggingFaceModels,
			defaultModelId: huggingFaceDefaultModelId,
		})
		return this.cachedModel
	}
}
