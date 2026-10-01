import { type ModelInfo } from "@shared/api"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import type { ApiHandler, ApiHandlerContext } from "../"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import type { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { splitInclusiveInputUsage } from "../transform/usage-normalization"

export class LmStudioHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.lmstudio
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
	private get lmStudioMaxTokens() {
		return this.config?.lmStudioNumCtx
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			try {
				this.client = createOpenAIClient({
					// Docs on the new v0 api endpoint: https://lmstudio.ai/docs/app/api/endpoints/rest
					baseURL: new URL("api/v0", this.baseUrl || "http://localhost:1234").toString(),
					apiKey: "noop",
				})
			} catch (error) {
				throw new Error(`Error creating LM Studio client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry({ retryAllErrors: true })
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		try {
			const stream = await client.chat.completions.create({
				model: this.getModel().id,
				messages: openAiMessages,
				stream: true,
				stream_options: { include_usage: true },
				max_completion_tokens: this.lmStudioMaxTokens ? Number(this.lmStudioMaxTokens) : undefined,
				...getOpenAIToolParams(tools),
			})

			const toolCallProcessor = new ToolCallProcessor()

			for await (const chunk of stream) {
				const choice = chunk.choices?.[0]
				const delta = choice?.delta
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
		} catch {
			// LM Studio doesn't return an error code/body for now
			throw new Error(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Cline's prompts. Alternatively, try enabling Compact Prompt in your settings when working with a limited context window.",
			)
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const model = resolveRuntimeModel(this.ctx.profile)
		const contextWindow = Number(this.lmStudioMaxTokens)
		if (Number.isNaN(contextWindow)) return model
		return { ...model, info: { ...model.info, capabilities: { ...model.info.capabilities, contextWindow } } }
	}
}
