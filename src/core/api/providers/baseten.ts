import { BasetenModelId, basetenDefaultModelId, basetenModels, ModelInfo } from "@shared/api"
import { providerFetch } from "@shared/net"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import { calculateApiCostOpenAI } from "@utils/cost"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { ClineStorageMessage } from "@/shared/messages/content"
import { ApiHandler, ApiHandlerContext } from "../"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { ToolCallProcessor } from "../transform/tool-call-processor"

export class BasetenHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.baseten
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
				throw new Error("Baseten API key is required")
			}
			try {
				this.client = new OpenAI({
					baseURL: this.baseUrl || "https://inference.baseten.co/v1",
					apiKey: this.apiKey,
					defaultHeaders: buildExternalBasicHeaders(),
					fetch: providerFetch,
				})
			} catch (error) {
				throw new Error(`Error creating Baseten client: ${error.message}`)
			}
		}
		return this.client
	}

	/**
	 * Gets the optimal max_tokens based on model capabilities
	 */
	private getOptimalMaxTokens(model: { id: BasetenModelId; info: ModelInfo }): number {
		// Use model-specific max tokens if available
		if (model.info.capabilities?.maxTokens && model.info.capabilities?.maxTokens > 0) {
			return model.info.capabilities?.maxTokens
		}

		// Default fallback
		return 8192
	}

	getModel(): { id: BasetenModelId; info: ModelInfo } {
		const model = resolveRuntimeModel(this.ctx.profile, { models: basetenModels, defaultModelId: basetenDefaultModelId })
		return { id: model.id as BasetenModelId, info: model.info }
	}

	private async *yieldUsage(modelInfo: ModelInfo, usage: OpenAI.CompletionUsage): ApiStream {
		if (usage.prompt_tokens || usage.completion_tokens) {
			const cost = calculateApiCostOpenAI(modelInfo, usage.prompt_tokens || 0, usage.completion_tokens || 0)

			yield {
				type: "usage",
				inputTokens: usage.prompt_tokens || 0,
				outputTokens: usage.completion_tokens || 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: cost,
			}
		}
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const maxTokens = this.getOptimalMaxTokens(model)
		const toolCallProcessor = new ToolCallProcessor()

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		const stream = await client.chat.completions.create({
			model: model.id,
			max_tokens: maxTokens,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			temperature: 0,
			tools,
			tool_choice: tools && tools.length > 0 ? "auto" : undefined,
		})

		let didOutputUsage = false

		for await (const chunk of stream) {
			const delta = chunk?.choices?.[0]?.delta

			// Handle reasoning field if present (for reasoning models with parsed output)
			if (delta && "reasoning" in delta && delta?.reasoning) {
				const reasoning = typeof delta.reasoning === "string" ? delta.reasoning : JSON.stringify(delta.reasoning)
				yield {
					type: "reasoning",
					reasoning,
				}
			}

			// Handle content field
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			// Handle usage information - only output once
			if (!didOutputUsage && chunk.usage) {
				yield* this.yieldUsage(model.info, chunk.usage)
				didOutputUsage = true
			}
		}
	}

	/**
	 * Checks if the current model supports tools
	 */
	supportsTools(): boolean {
		return this.getModel().info.capabilities?.supportsTools === true
	}
}
