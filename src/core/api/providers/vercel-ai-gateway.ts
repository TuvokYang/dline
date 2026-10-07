import { ModelInfo, openRouterDefaultModelId, openRouterDefaultModelInfo } from "@shared/api"
import { resolveProfileModelId, resolveRuntimeModel } from "@shared/providers/profile-model-info"
import { shouldSkipReasoningForModel } from "@utils/model-utils"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { ApiHandler, ApiHandlerContext } from "../index"
import { withRetry } from "../retry"
import { ApiStream } from "../transform/stream"
import { ToolCallProcessor } from "../transform/tool-call-processor"
import { createVercelAIGatewayStream } from "../transform/vercel-ai-gateway-stream"

function getCacheReadTokens(usage: any): number {
	return usage?.prompt_tokens_details?.cached_tokens || usage?.cache_read_input_tokens || 0
}

function getCacheWriteTokens(usage: any): number {
	return usage?.prompt_tokens_details?.cache_write_tokens || usage?.cache_creation_input_tokens || 0
}

export class VercelAIGatewayHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.vercelAiGateway
	}
	private get apiKey() {
		return this.ctx.profile.apiKey
	}
	private get modelId() {
		return resolveProfileModelId(this.ctx.profile)
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
		return this.config?.reasoning?.thinkingBudget
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.apiKey) {
				throw new Error("Vercel AI Gateway API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: this.baseUrl || "https://ai-gateway.vercel.sh/v1",
					apiKey: this.apiKey,
					defaultHeaders: {
						"http-referer": "https://cline.bot",
						"x-title": "Cline",
					},
				})
			} catch (error: any) {
				throw new Error(`Error creating Vercel AI Gateway client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const modelId = this.getModel().id
		const modelInfo = this.getModel().info

		try {
			const stream = await createVercelAIGatewayStream(
				client,
				systemPrompt,
				messages,
				{ id: modelId, info: modelInfo },
				this.reasoningEffort,
				this.thinkingBudgetTokens,
				tools,
				this.config?.reasoning,
			)
			let didOutputUsage = false

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

				// Reasoning tokens are returned separately from the content
				// Skip reasoning content for models that don't support it (e.g., devstral, grok-4)
				if (delta && "reasoning" in delta && delta.reasoning && !shouldSkipReasoningForModel(this.modelId)) {
					yield {
						type: "reasoning",
						reasoning: typeof delta.reasoning === "string" ? delta.reasoning : JSON.stringify(delta.reasoning),
					}
				}

				// Reasoning details that can be passed back in API requests to preserve reasoning traces
				if (
					delta &&
					"reasoning_details" in delta &&
					// @ts-expect-error-next-line
					delta.reasoning_details?.length && // exists and non-0
					!shouldSkipReasoningForModel(this.modelId)
				) {
					yield {
						type: "reasoning",
						reasoning: "",
						details: delta.reasoning_details,
					}
				}

				if (!didOutputUsage && chunk.usage) {
					// @ts-expect-error - Vercel AI Gateway extends OpenAI types
					const totalCost = (chunk.usage.cost || 0) + (chunk.usage.cost_details?.upstream_inference_cost || 0)
					const cacheReadTokens = getCacheReadTokens(chunk.usage)
					const cacheWriteTokens = getCacheWriteTokens(chunk.usage)

					yield {
						type: "usage",
						cacheWriteTokens,
						cacheReadTokens,
						inputTokens: Math.max(0, (chunk.usage.prompt_tokens || 0) - cacheReadTokens - cacheWriteTokens),
						outputTokens: chunk.usage.completion_tokens || 0,
						totalCost,
					}
					didOutputUsage = true
				}
			}

			if (!didOutputUsage) {
				Logger.warn("Vercel AI Gateway did not provide usage information in stream")
			}
		} catch (error: any) {
			Logger.error("Vercel AI Gateway error details:", error)
			Logger.error("Error stack:", error.stack)
			throw new Error(`Vercel AI Gateway error: ${error.message}`)
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return resolveRuntimeModel(this.ctx.profile, {
			models: { [openRouterDefaultModelId]: openRouterDefaultModelInfo },
			defaultModelId: openRouterDefaultModelId,
		})
	}
}
