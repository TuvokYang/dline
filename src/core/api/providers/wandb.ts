import { type ModelInfo, wandbDefaultModelId, wandbModels } from "@shared/api"
import { resolveProfileModelId, resolveRuntimeModel } from "@shared/providers/profile-model-info"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiHandler, ApiHandlerContext } from "../index"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

export class WandbHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.wandb
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
				throw new Error("W&B API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: this.baseUrl || "https://api.inference.wandb.ai/v1",
					apiKey: this.apiKey,
				})
			} catch (error) {
				throw new Error(`Error creating W&B Inference client: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()

		const stream = await client.chat.completions.create({
			model: model.id,
			messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
			temperature: 0,
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

			if (delta && "reasoning" in delta && delta.reasoning) {
				yield {
					type: "reasoning",
					reasoning: typeof delta.reasoning === "string" ? delta.reasoning : JSON.stringify(delta.reasoning),
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			if (chunk.usage) {
				// W&B Inference returns prompt_tokens_details.cached_tokens in the usage chunk,
				// but does not currently offer cache-aware billing (cached tokens are billed
				// at the same rate as regular input tokens). We report inputTokens as the full
				// prompt_tokens value and do not subtract cached tokens until W&B supports
				// cache-aware pricing. This may change in a future update.
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
				}
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const id = resolveProfileModelId(this.ctx.profile).trim() || wandbDefaultModelId
		const modelInfo = this.ctx.profile.modelInfo
		return resolveRuntimeModel(
			{ ...this.ctx.profile, modelId: id, modelInfo: modelInfo?.id.trim() === id ? { ...modelInfo, id } : undefined },
			{ models: wandbModels, defaultModelId: wandbDefaultModelId },
		)
	}
}
