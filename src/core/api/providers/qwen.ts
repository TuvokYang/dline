import {
	InternationalQwenModelId,
	internationalQwenDefaultModelId,
	internationalQwenModels,
	MainlandQwenModelId,
	ModelInfo,
	mainlandQwenDefaultModelId,
	mainlandQwenModels,
	QwenApiRegions,
} from "@shared/api"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { ApiHandler, ApiHandlerContext } from "../"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToR1Format } from "../transform/r1-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { splitInclusiveInputUsage } from "../transform/usage-normalization"
import { resolveQwenThinking } from "./qwen/reasoning"

export class QwenHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.qwen
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
		return (this.config?.qwenApiLine ?? QwenApiRegions.CHINA) === QwenApiRegions.CHINA
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.apiKey) {
				throw new Error("Alibaba API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL:
						this.baseUrl ||
						(this.useChinaApi()
							? "https://dashscope.aliyuncs.com/compatible-mode/v1"
							: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
					apiKey: this.apiKey,
				})
			} catch (error: any) {
				throw new Error(`Error creating Alibaba client: ${error.message}`)
			}
		}
		return this.client
	}

	getModel(): { id: MainlandQwenModelId | InternationalQwenModelId; info: ModelInfo } {
		const models = this.useChinaApi() ? mainlandQwenModels : internationalQwenModels
		const defaultId = this.useChinaApi() ? mainlandQwenDefaultModelId : internationalQwenDefaultModelId
		const id = this.modelId || this.modelInfo?.id || defaultId
		const baseModel = this.modelInfo?.id === id ? this.modelInfo : models[id]
		return {
			id,
			info: buildEffectiveModelInfo(id, baseModel, {
				capabilities: this.config?.capabilities,
				pricing: this.config?.pricing,
			}),
		}
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const isDeepseekReasoner = model.id.includes("deepseek-r1")

		let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		let temperature: number | undefined = 0
		const reasoning = resolveQwenThinking(model.info.capabilities, this.config?.reasoning)

		if (isDeepseekReasoner || reasoning.enabled) {
			openAiMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
			temperature = undefined
		}

		const stream = await client.chat.completions.create({
			model: model.id,
			max_completion_tokens: model.info.capabilities?.maxTokens,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			temperature,
			...reasoning.fields,
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
				try {
					yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
				} catch (error) {
					Logger.error("Error processing tool call delta:", error, delta.tool_calls)
				}
			}

			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				yield {
					type: "reasoning",
					reasoning: (delta.reasoning_content as string | undefined) || "",
				}
			}

			if (chunk.usage) {
				const inputUsage = splitInclusiveInputUsage({
					totalInputTokens: chunk.usage.prompt_tokens,
					// @ts-expect-error-next-line
					cacheReadTokens: chunk.usage.prompt_cache_hit_tokens,
					// @ts-expect-error-next-line
					cacheWriteTokens: chunk.usage.prompt_cache_miss_tokens,
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
