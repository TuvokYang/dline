import {
	internationalZAiDefaultModelId,
	internationalZAiModels,
	ModelInfo,
	mainlandZAiDefaultModelId,
	mainlandZAiModels,
} from "@shared/api"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { version as extensionVersion } from "../../../../package.json"
import { ApiHandler, ApiHandlerContext } from ".."
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { splitInclusiveInputUsage } from "../transform/usage-normalization"

export class ZAiHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.zai
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

	private useChinaApi(): boolean {
		return this.config?.zaiApiLine === "china"
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.apiKey) {
				throw new Error("Z AI API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL:
						this.baseUrl ||
						(this.useChinaApi() ? "https://open.bigmodel.cn/api/paas/v4" : "https://api.z.ai/api/paas/v4"),
					apiKey: this.apiKey,
					defaultHeaders: {
						"HTTP-Referer": "https://cline.bot",
						"X-Title": "Cline",
						"X-Cline-Version": extensionVersion,
					},
				})
			} catch (error: any) {
				throw new Error(`Error creating Z AI client: ${error.message}`)
			}
		}
		return this.client
	}

	getModel(): { id: string; info: ModelInfo } {
		return resolveRuntimeModel(
			this.ctx.profile,
			this.useChinaApi()
				? { models: mainlandZAiModels, defaultModelId: mainlandZAiDefaultModelId }
				: { models: internationalZAiModels, defaultModelId: internationalZAiDefaultModelId },
		)
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]
		const stream = await client.chat.completions.create({
			model: model.id,
			max_completion_tokens: model.info.capabilities?.maxTokens,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			...getOpenAIToolParams(tools),
		})

		const toolCallProcessor = new ToolCallProcessor()

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
				const inputUsage = splitInclusiveInputUsage({
					totalInputTokens: chunk.usage.prompt_tokens,
					cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
				})
				yield {
					type: "usage",
					...inputUsage,
					outputTokens: chunk.usage.completion_tokens || 0,
				}
			}
		}
	}
}
