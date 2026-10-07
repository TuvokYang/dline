import { ModelInfo, requestyDefaultModelId, requestyDefaultModelInfo } from "@shared/api"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import { calculateApiCostOpenAI } from "@utils/cost"
import OpenAI from "openai"
import { toRequestyServiceStringUrl } from "@/shared/clients/requesty"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiHandler, ApiHandlerContext } from "../index"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { splitInclusiveInputUsage } from "../transform/usage-normalization"
import { resolveAnthropicReasoning } from "./anthropic/reasoning"
import { resolveOpenAIReasoningEffort } from "./openai/reasoning"

// Requesty usage includes an extra field for Anthropic use cases.
// Safely cast the prompt token details section to the appropriate structure.
interface RequestyUsage extends OpenAI.CompletionUsage {
	prompt_tokens_details?: {
		caching_tokens?: number
		cached_tokens?: number
	}
	total_cost?: number
}

export class RequestyHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.requesty
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
				throw new Error("Requesty API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: toRequestyServiceStringUrl(this.baseUrl),
					apiKey: this.apiKey,
					defaultHeaders: {
						"HTTP-Referer": "https://cline.bot",
						"X-Title": "Cline",
					},
				})
			} catch (error: any) {
				throw new Error(`Error creating Requesty client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// The route selects the wire format, never the capability or thinking mode.
		const anthropicRoute = model.id.startsWith("anthropic/")
		const anthropicReasoning = anthropicRoute
			? resolveAnthropicReasoning(model.info.capabilities, this.config?.reasoning)
			: undefined
		const effort = anthropicRoute ? undefined : resolveOpenAIReasoningEffort(model.info.capabilities, this.config?.reasoning)
		const reasoningArgs = effort ? { reasoning_effort: effort } : {}
		const thinkingArgs = {
			...(anthropicReasoning?.thinking ? { thinking: anthropicReasoning.thinking } : {}),
			...(anthropicReasoning?.outputConfig ? { output_config: anthropicReasoning.outputConfig } : {}),
		}

		const stream = await client.chat.completions.create({
			model: model.id,
			max_tokens: model.info.capabilities?.maxTokens || undefined,
			messages: openAiMessages,
			...(anthropicReasoning?.adaptive || anthropicReasoning?.enabled ? {} : { temperature: 0 }),
			stream: true,
			stream_options: { include_usage: true },
			...reasoningArgs,
			...thinkingArgs,
		})

		let lastUsage: any

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
				lastUsage = chunk.usage
			}
		}

		if (lastUsage) {
			const usage = lastUsage as RequestyUsage
			const totalInputTokens = usage.prompt_tokens || 0
			const outputTokens = usage.completion_tokens || 0
			const inputUsage = splitInclusiveInputUsage({
				totalInputTokens,
				cacheWriteTokens: usage.prompt_tokens_details?.caching_tokens,
				cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
			})
			const totalCost = calculateApiCostOpenAI(
				model.info,
				totalInputTokens,
				outputTokens,
				inputUsage.cacheWriteTokens,
				inputUsage.cacheReadTokens,
			)

			yield {
				type: "usage",
				...inputUsage,
				outputTokens,
				totalCost,
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return resolveRuntimeModel(this.ctx.profile, {
			models: { [requestyDefaultModelId]: requestyDefaultModelInfo },
			defaultModelId: requestyDefaultModelId,
		})
	}
}
