import { groqDefaultModelId, groqModels, ModelInfo } from "@shared/api"
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
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { splitInclusiveInputUsage } from "../transform/usage-normalization"

// Enhanced usage interface to support Groq's cached token fields
interface GroqUsage extends OpenAI.CompletionUsage {
	prompt_tokens_details?: {
		cached_tokens?: number
	}
}

// Model family definitions for enhanced behavior
interface GroqModelFamily {
	name: string
	supportedFeatures: {
		streaming: boolean
		temperature: boolean
		vision: boolean
		tools: boolean
	}
	maxTokensOverride?: number
	specialParams?: Record<string, any>
}

const MODEL_FAMILIES: Record<string, GroqModelFamily> = {
	// Moonshort 4 Family - Latest generation with vision support
	"kimi-k2": {
		name: "kimi-k2",
		supportedFeatures: { streaming: true, temperature: true, vision: true, tools: true },
		maxTokensOverride: 8192,
	},
	// Llama 4 Family - Latest generation with vision support
	llama4: {
		name: "Llama 4",
		supportedFeatures: { streaming: true, temperature: true, vision: true, tools: true },
		maxTokensOverride: 8192,
	},
	// Llama 3.3 Family - Balanced performance
	"llama3.3": {
		name: "Llama 3.3",
		supportedFeatures: { streaming: true, temperature: true, vision: false, tools: true },
		maxTokensOverride: 32768,
	},
	// Llama 3.1 Family - Fast inference
	"llama3.1": {
		name: "Llama 3.1",
		supportedFeatures: { streaming: true, temperature: true, vision: false, tools: true },
		maxTokensOverride: 131072,
	},
	// DeepSeek Family - Reasoning-optimized
	deepseek: {
		name: "DeepSeek",
		supportedFeatures: { streaming: true, temperature: true, vision: false, tools: true },
		maxTokensOverride: 8192,
		specialParams: {
			top_p: 0.95,
			reasoning_format: "parsed",
		},
	},
	// Qwen Family - Enhanced for Q&A
	qwen: {
		name: "Qwen",
		supportedFeatures: { streaming: true, temperature: true, vision: false, tools: true },
		maxTokensOverride: 32768,
	},
	// Compound Models - Hybrid architectures
	compound: {
		name: "Compound",
		supportedFeatures: { streaming: true, temperature: true, vision: false, tools: true },
		maxTokensOverride: 8192,
	},
}

export class GroqHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.groq
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
				throw new Error("Groq API key is required")
			}
			try {
				this.client = new OpenAI({
					baseURL: this.baseUrl || "https://api.groq.com/openai/v1",
					apiKey: this.apiKey,
					defaultHeaders: buildExternalBasicHeaders(),
					fetch: providerFetch,
				})
			} catch (error) {
				throw new Error(`Error creating Groq client: ${error.message}`)
			}
		}
		return this.client
	}

	private async *yieldUsage(info: ModelInfo, usage: GroqUsage | undefined): ApiStream {
		const totalInputTokens = usage?.prompt_tokens || 0
		const outputTokens = usage?.completion_tokens || 0
		const inputUsage = splitInclusiveInputUsage({
			totalInputTokens,
			cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens,
		})

		// Calculate cost with the Provider total; canonical usage remains non-overlapping.
		const totalCost = calculateApiCostOpenAI(
			info,
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

	/**
	 * Detects the model family based on the model ID
	 */
	private detectModelFamily(modelId: string): GroqModelFamily {
		if (modelId.includes("kimi-k2")) {
			return MODEL_FAMILIES["kimi-k2"]
		}
		// Llama 4 variants
		if (modelId.includes("llama-4") || modelId.includes("llama/llama-4")) {
			return MODEL_FAMILIES.llama4
		}
		// Llama 3.3 variants
		if (modelId.includes("llama-3.3")) {
			return MODEL_FAMILIES["llama3.3"]
		}
		// Llama 3.1 variants
		if (modelId.includes("llama-3.1")) {
			return MODEL_FAMILIES["llama3.1"]
		}
		// DeepSeek variants
		if (modelId.includes("deepseek")) {
			return MODEL_FAMILIES.deepseek
		}
		// Qwen variants
		if (modelId.includes("qwen")) {
			return MODEL_FAMILIES.qwen
		}
		// Compound variants
		if (modelId.includes("compound")) {
			return MODEL_FAMILIES.compound
		}

		// Default fallback to Llama 3.3 behavior
		return MODEL_FAMILIES["kimi-k2"]
	}

	/**
	 * Gets the optimal max_tokens based on model family and capabilities
	 */
	private getOptimalMaxTokens(model: { id: string; info: ModelInfo }, modelFamily: GroqModelFamily): number {
		// Use model-specific max tokens if available
		if (model.info.capabilities?.maxTokens && model.info.capabilities?.maxTokens > 0) {
			return model.info.capabilities?.maxTokens
		}

		// Use family override if available
		if (modelFamily.maxTokensOverride) {
			return modelFamily.maxTokensOverride
		}

		// Default fallback
		return 8192
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const modelFamily = this.detectModelFamily(model.id)

		// Optimize parameters based on model family
		const temperature = 0
		const maxTokens = this.getOptimalMaxTokens(model, modelFamily)

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// Build request parameters with model-specific optimizations
		const requestParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming & {
			reasoning_format?: "parsed" | "raw" | "hidden"
			top_p?: number
		} = {
			model: model.id,
			max_tokens: maxTokens,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			temperature,
			...getOpenAIToolParams(tools),
		}

		// Add any special parameters for specific model families
		if (modelFamily.specialParams) {
			Object.assign(requestParams, modelFamily.specialParams)
		}

		const toolCallProcessor = new ToolCallProcessor()
		const stream = await client.chat.completions.create(requestParams)

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta

			// Handle reasoning field if present (for reasoning models with parsed output)
			if ((delta as any)?.reasoning) {
				const reasoningContent = (delta as any).reasoning as string
				yield {
					type: "reasoning",
					reasoning: reasoningContent,
				}
				continue
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			// Handle content field - trust the parsed output from Groq
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			// Handle usage information
			if (chunk.usage) {
				yield* this.yieldUsage(model.info, chunk.usage)
			}
		}
	}

	/**
	 * Checks if the current model supports vision/images
	 */
	supportsImages(): boolean {
		const model = this.getModel()
		return model.info.capabilities?.supportsImages === true
	}

	/**
	 * Checks if the current model supports tools
	 */
	supportsTools(): boolean {
		return this.getModel().info.capabilities?.supportsTools === true
	}

	/**
	 * Gets model information with enhanced family detection
	 */
	getModel(): { id: string; info: ModelInfo } {
		return resolveRuntimeModel(this.ctx.profile, { models: groqModels, defaultModelId: groqDefaultModelId })
	}

	/**
	 * Gets model family information
	 */
	getModelFamily(): GroqModelFamily {
		const model = this.getModel()
		return this.detectModelFamily(model.id)
	}
}
