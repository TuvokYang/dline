import { fireworksDefaultModelId, fireworksModels, ModelInfo } from "@shared/api"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import OpenAI from "openai"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiHandler, ApiHandlerContext } from ".."
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { splitInclusiveInputUsage } from "../transform/usage-normalization"

export class FireworksHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.fireworks
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
				throw new Error("Fireworks API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: this.baseUrl || "https://api.fireworks.ai/inference/v1",
					apiKey: this.apiKey,
				})
			} catch (error) {
				throw new Error(`Error creating Fireworks client: ${error.message}`)
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

		const stream = await client.chat.completions.create({
			model: modelId,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			temperature: 0,
		})

		let reasoning: string | null = null
		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (reasoning || delta?.content?.includes("<think>")) {
				reasoning = (reasoning || "") + (delta.content ?? "")
			}

			if (delta?.content && !reasoning) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (reasoning || (delta && "reasoning_content" in delta && delta.reasoning_content)) {
				yield {
					type: "reasoning",
					reasoning: delta.content || ((delta as any).reasoning_content as string | undefined) || "",
				}
				if (reasoning?.includes("</think>")) {
					// Reset so the next chunk is regular content
					reasoning = null
				}
			}

			if (chunk.usage) {
				const usage = chunk.usage as OpenAI.CompletionUsage & {
					prompt_cache_hit_tokens?: number
					prompt_cache_miss_tokens?: number
					prompt_tokens_details?: {
						cached_tokens?: number
					}
				}
				const inputUsage = splitInclusiveInputUsage({
					totalInputTokens: usage.prompt_tokens,
					// Fireworks can return cache hits either as prompt_cache_hit_tokens or prompt_tokens_details.cached_tokens.
					cacheReadTokens: usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens,
					cacheWriteTokens: usage.prompt_cache_miss_tokens,
				})
				yield {
					type: "usage",
					...inputUsage,
					outputTokens: usage.completion_tokens || 0,
				}
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return resolveRuntimeModel(this.ctx.profile, { models: fireworksModels, defaultModelId: fireworksDefaultModelId })
	}
}
