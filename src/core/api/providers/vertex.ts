import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import { FunctionDeclaration as GoogleTool } from "@google/genai"
import { CLAUDE_SONNET_1M_SUFFIX, ModelInfo, VertexModelId, vertexDefaultModelId, vertexModels } from "@shared/api"
import { observeProviderStream } from "@shared/provider-attempt-observer"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { ClineStorageMessage } from "@/shared/messages/content"
import { ClineTool } from "@/shared/tools"
import { ApiHandler, ApiHandlerContext } from "../"
import { withRetry } from "../retry"
import { sanitizeAnthropicMessages } from "../transform/anthropic-format"
import { ApiStream } from "../transform/stream"
import { getThinkingTokens } from "../utils/messages_api_support"
import { resolveAnthropicReasoning } from "./anthropic/reasoning"
import { GeminiHandler } from "./gemini"

export class VertexHandler implements ApiHandler {
	private geminiHandler: GeminiHandler | undefined
	private clientAnthropic: AnthropicVertex | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.vertex
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

	private ensureGeminiHandler(): GeminiHandler {
		if (!this.geminiHandler) {
			try {
				// Create a GeminiHandler with isVertex flag for Gemini models
				this.geminiHandler = new GeminiHandler(this.ctx)
			} catch (error: any) {
				throw new Error(`Error creating Vertex AI Gemini handler: ${error.message}`)
			}
		}
		return this.geminiHandler
	}

	private createAnthropicClientOptions(externalHeaders: Record<string, string>) {
		return {
			projectId: this.config?.vertexProjectId,
			maxRetries: 0,
			// https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude#regions
			region: this.config?.vertexRegion,
			defaultHeaders: externalHeaders,
		}
	}

	private ensureAnthropicClient(): AnthropicVertex {
		if (!this.clientAnthropic) {
			if (!this.config?.vertexProjectId) {
				throw new Error("Vertex AI project ID is required")
			}
			if (!this.config?.vertexRegion) {
				throw new Error("Vertex AI region is required")
			}
			try {
				const externalHeaders = buildExternalBasicHeaders()
				// Initialize Anthropic client for Claude models
				this.clientAnthropic = new AnthropicVertex(this.createAnthropicClientOptions(externalHeaders))
			} catch (error: any) {
				throw new Error(`Error creating Vertex AI Anthropic client: ${error.message}`)
			}
		}
		return this.clientAnthropic
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: ClineTool[]): ApiStream {
		const model = this.getModel()
		const rawModelId = model.id
		const modelId = rawModelId.endsWith(CLAUDE_SONNET_1M_SUFFIX)
			? rawModelId.slice(0, -CLAUDE_SONNET_1M_SUFFIX.length)
			: rawModelId

		// For Gemini models, use the GeminiHandler
		if (!rawModelId.includes("claude")) {
			const geminiHandler = this.ensureGeminiHandler()
			yield* geminiHandler.createMessage(systemPrompt, messages, tools as GoogleTool[])
			return
		}

		const clientAnthropic = this.ensureAnthropicClient()

		const reasoning = resolveAnthropicReasoning(model.info.capabilities, this.config?.reasoning)

		// Tools are available only when native tools are enabled.
		const nativeToolsOn = tools?.length ? tools?.length > 0 : false

		const anthropicMessages = sanitizeAnthropicMessages(messages, model.info.capabilities?.supportsPromptCache ?? false)

		const requestBody: Record<string, unknown> = {
			model: modelId,
			max_tokens: model.info.capabilities?.maxTokens || 8192,
			thinking: reasoning.thinking,
			temperature: reasoning.adaptive || reasoning.enabled ? undefined : 0,
			system: [
				{
					text: systemPrompt,
					type: "text",
					cache_control: model.info.capabilities?.supportsPromptCache ? { type: "ephemeral" } : undefined,
				},
			],
			messages: anthropicMessages,
			stream: true,
			tools: nativeToolsOn ? (tools as AnthropicTool[]) : undefined,
			// tool_choice options:
			// - none: disables tool use, even if tools are provided. Claude will not call any tools.
			// - auto: allows Claude to decide whether to call any provided tools or not. This is the default value when tools are provided.
			// - any: tells Claude that it must use one of the provided tools, but doesn’t force a particular tool.
			// A model that rejects forcing fails the whole request rather than
			// degrading, and thinking cannot be combined with a forced choice.
			tool_choice: !nativeToolsOn
				? undefined
				: model.info.capabilities?.supportsForcedToolUse === false
					? { type: "auto" }
					: !reasoning.enabled
						? { type: "any" }
						: undefined,
		}
		if (reasoning.outputConfig) {
			requestBody.output_config = reasoning.outputConfig
		}

		const stream = await observeProviderStream(
			() => clientAnthropic.beta.messages.create(requestBody as any) as unknown as PromiseLike<AsyncIterable<any>>,
		)

		const lastStartedToolCall = { id: "", name: "", arguments: "" }

		for await (const chunk of stream) {
			switch (chunk?.type) {
				case "message_start": {
					const usage = chunk.message.usage
					yield {
						type: "usage",
						inputTokens: usage.input_tokens || 0,
						outputTokens: usage.output_tokens || 0,
						cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
						cacheReadTokens: usage.cache_read_input_tokens || undefined,
						...getThinkingTokens(usage),
					}
					break
				}
				case "message_delta":
					yield {
						type: "usage",
						inputTokens: 0,
						outputTokens: chunk.usage?.output_tokens || 0,
						...(chunk.usage ? getThinkingTokens(chunk.usage) : undefined),
					}
					break
				case "message_stop":
					break
				case "content_block_start":
					switch (chunk.content_block.type) {
						case "thinking":
							yield {
								type: "reasoning",
								reasoning: chunk.content_block.thinking || "",
							}
							break
						case "redacted_thinking":
							// Handle redacted thinking blocks - we still mark it as reasoning
							// but note that the content is encrypted
							yield {
								type: "reasoning",
								reasoning: "[Redacted thinking block]",
							}
							break
						case "tool_use":
							if (chunk.content_block.id && chunk.content_block.name) {
								// Convert Anthropic tool_use to OpenAI-compatible format
								lastStartedToolCall.id = chunk.content_block.id
								lastStartedToolCall.name = chunk.content_block.name
								lastStartedToolCall.arguments = ""
							}
							break
						case "text":
							if (chunk.index > 0) {
								yield {
									type: "text",
									text: "\n",
								}
							}
							yield {
								type: "text",
								text: chunk.content_block.text,
							}
							break
					}
					break
				case "content_block_delta":
					switch (chunk.delta.type) {
						case "signature_delta":
							yield {
								type: "reasoning",
								reasoning: "",
								signature: chunk.delta.signature,
							}
							break
						case "thinking_delta":
							yield {
								type: "reasoning",
								reasoning: chunk.delta.thinking,
							}
							break
						case "input_json_delta":
							if (lastStartedToolCall.id && lastStartedToolCall.name && chunk.delta.partial_json) {
								// 	// Convert Anthropic tool_use to OpenAI-compatible format
								yield {
									type: "tool_calls",
									function_id: lastStartedToolCall.id,
									tool_call: {
										function: {
											name: lastStartedToolCall.name,
											arguments: chunk.delta.partial_json,
										},
									},
								}
							}
							break
						case "text_delta":
							yield {
								type: "text",
								text: chunk.delta.text,
							}
							break
					}
					break
				case "content_block_stop":
					lastStartedToolCall.id = ""
					lastStartedToolCall.name = ""
					lastStartedToolCall.arguments = ""
					break
			}
		}
	}

	getModel(): { id: VertexModelId; info: ModelInfo } {
		const model = resolveRuntimeModel(this.ctx.profile, { models: vertexModels, defaultModelId: vertexDefaultModelId })
		return { id: model.id as VertexModelId, info: model.info }
	}
}
