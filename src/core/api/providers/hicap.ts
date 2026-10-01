import { ModelInfo } from "@shared/api"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import OpenAI from "openai"
import type { ChatCompletionReasoningEffort } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiHandler, ApiHandlerContext } from "../index"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { splitInclusiveInputUsage } from "../transform/usage-normalization"

export class HicapHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.hicap
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

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.apiKey) {
				throw new Error("Hicap API key is required")
			}
			if (!this.getModel().id) {
				throw new Error("Model ID is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: this.baseUrl || "https://api.hicap.ai/v2/openai",
					apiKey: this.apiKey,
					defaultHeaders: {
						"api-key": this.apiKey,
					},
				})
			} catch (error: any) {
				throw new Error(`Error creating OpenAI client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[]): ApiStream {
		const client = this.ensureClient()
		const modelId = this.getModel().id

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]
		const temperature: number = 1
		let reasoningEffort: ChatCompletionReasoningEffort | undefined
		let maxTokens: number | undefined

		const stream = await client.chat.completions.create({
			model: modelId,
			messages: openAiMessages,
			temperature,
			max_tokens: maxTokens,
			reasoning_effort: reasoningEffort,
			stream: true,
			stream_options: { include_usage: true },
		})
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
		return resolveRuntimeModel(this.ctx.profile)
	}
}
