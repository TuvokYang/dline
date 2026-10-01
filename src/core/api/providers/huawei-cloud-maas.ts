import { HuaweiCloudMaasModelId, huaweiCloudMaasDefaultModelId, huaweiCloudMaasModels, ModelInfo } from "@shared/api"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiHandler, ApiHandlerContext } from ".."
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

export class HuaweiCloudMaaSHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.huaweiCloudMaas
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
				throw new Error("Huawei Cloud MaaS API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: this.baseUrl || "https://api.modelarts-maas.com/v1/",
					apiKey: this.apiKey,
				})
			} catch (error) {
				throw new Error(`Error creating Huawei Cloud MaaS client: ${error.message}`)
			}
		}
		return this.client
	}

	getModel(): { id: HuaweiCloudMaasModelId; info: ModelInfo } {
		const model = resolveRuntimeModel(this.ctx.profile, {
			models: huaweiCloudMaasModels,
			defaultModelId: huaweiCloudMaasDefaultModelId,
		})
		return { id: model.id as HuaweiCloudMaasModelId, info: model.info }
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
			temperature: 0,
			...getOpenAIToolParams(tools),
		})

		let reasoning: string | null = null
		let didOutputUsage = false
		let finalUsage: any = null

		const toolCallProcessor = new ToolCallProcessor()

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta

			// Handle reasoning content detection
			if (delta?.content) {
				if (reasoning || delta.content.includes("<think>")) {
					reasoning = (reasoning || "") + delta.content
				} else if (!reasoning) {
					yield {
						type: "text",
						text: delta.content,
					}
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			// Handle reasoning output
			if (reasoning || (delta && "reasoning_content" in delta && delta.reasoning_content)) {
				const reasoningContent = delta?.content || ((delta as any)?.reasoning_content as string | undefined) || ""
				if (reasoningContent.trim()) {
					yield {
						type: "reasoning",
						reasoning: reasoningContent,
					}
				}

				// Check if reasoning is complete
				if (reasoning?.includes("</think>")) {
					reasoning = null
				}
			}

			// Store usage information for later output
			if (chunk.usage) {
				finalUsage = chunk.usage
			}

			// Output usage when stream is finished
			if (!didOutputUsage && chunk.choices?.[0]?.finish_reason) {
				if (finalUsage) {
					yield {
						type: "usage",
						inputTokens: finalUsage.prompt_tokens || 0,
						outputTokens: finalUsage.completion_tokens || 0,
						cacheWriteTokens: 0,
						cacheReadTokens: 0,
					}
				}
				didOutputUsage = true
			}
		}
	}
}
