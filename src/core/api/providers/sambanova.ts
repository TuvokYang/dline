import { ModelInfo, sambanovaDefaultModelId, sambanovaModels } from "@shared/api"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiHandler, ApiHandlerContext } from "../index"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToR1Format } from "../transform/r1-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

export class SambanovaHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.sambanova
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
				throw new Error("SambaNova API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: this.baseUrl || "https://api.sambanova.ai/v1",
					apiKey: this.apiKey,
				})
			} catch (error: any) {
				throw new Error(`Error creating SambaNova client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()

		let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		const modelId = model.id.toLowerCase()

		if (modelId.includes("deepseek") || modelId.includes("qwen3")) {
			openAiMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
		}

		const toolCallProcessor = new ToolCallProcessor()
		const stream = await client.chat.completions.create({
			model: this.getModel().id,
			messages: openAiMessages,
			temperature: ((model as any).info?.temperature as any) ?? 0,
			stream: true,
			stream_options: { include_usage: true },
			...getOpenAIToolParams(tools),
		})

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			if (chunk.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
				}
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return resolveRuntimeModel(this.ctx.profile, { models: sambanovaModels, defaultModelId: sambanovaDefaultModelId })
	}
}
