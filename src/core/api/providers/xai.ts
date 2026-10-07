import { ModelInfo, xaiDefaultModelId, xaiModels } from "@shared/api"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import { shouldSkipReasoningForModel } from "@utils/model-utils"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiHandler, ApiHandlerContext } from "../"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { splitInclusiveInputUsage } from "../transform/usage-normalization"

export class XAIHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.xai
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

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.apiKey) {
				throw new Error("xAI API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: this.baseUrl || "https://api.x.ai/v1",
					apiKey: this.apiKey,
				})
			} catch (error: any) {
				throw new Error(`Error creating xAI client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const modelId = this.getModel().id
		const stream = await client.chat.completions.create({
			model: modelId,
			max_completion_tokens: this.getModel().info.capabilities?.maxTokens,
			temperature: 0,
			messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
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

			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				// Skip reasoning content for Grok 4 models since it only displays "thinking" without providing useful information
				if (!shouldSkipReasoningForModel(modelId)) {
					yield {
						type: "reasoning",
						// @ts-expect-error-next-line
						reasoning: delta.reasoning_content,
					}
				}
			}

			if (chunk.usage) {
				const inputUsage = splitInclusiveInputUsage({
					totalInputTokens: chunk.usage.prompt_tokens,
					cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
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

	getModel(): { id: string; info: ModelInfo } {
		return resolveRuntimeModel(this.ctx.profile, { models: xaiModels, defaultModelId: xaiDefaultModelId })
	}
}
