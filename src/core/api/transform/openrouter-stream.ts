import {
	CLAUDE_SONNET_1M_SUFFIX,
	ModelInfo,
	OPENROUTER_PROVIDER_PREFERENCES,
	openRouterClaudeOpus461mModelId,
	openRouterClaudeOpus471mModelId,
	openRouterClaudeSonnet41mModelId,
	openRouterClaudeSonnet451mModelId,
	openRouterClaudeSonnet461mModelId,
} from "@shared/api"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { GEMINI_FLASH_MAX_OUTPUT_TOKENS, isGeminiFlashModel, shouldSkipReasoningForModel } from "@utils/model-utils"
import OpenAI from "openai"
import { ChatCompletionTool } from "openai/resources/chat/completions"
import type { ClineStorageMessage } from "@/shared/messages/content"
import { resolveOpenRouterReasoning } from "../providers/openrouter/reasoning"
import { convertToOpenAiMessages, sanitizeGeminiMessages } from "./openai-format"
import { convertToR1Format } from "./r1-format"
import { getOpenAIToolParams } from "./tool-call-processor"

const openRouterExplicitCacheControlModelIds = new Set([
	"deepseek/deepseek-v3.2",
	"qwen/qwen-plus",
	"qwen/qwen3-max",
	"qwen/qwen3.6-plus",
	"qwen/qwen3-coder-plus",
	"qwen/qwen3-coder-flash",
])

function needsExplicitCacheControl(modelId: string): boolean {
	return (
		modelId.startsWith("anthropic/") || modelId.startsWith("minimax/") || openRouterExplicitCacheControlModelIds.has(modelId)
	)
}

export async function createOpenRouterStream(
	client: OpenAI,
	systemPrompt: string,
	messages: ClineStorageMessage[],
	model: { id: string; info: ModelInfo },
	reasoningEffort?: string,
	thinkingBudgetTokens?: number,
	openRouterProviderSorting?: string,
	tools?: Array<ChatCompletionTool>,
	enableParallelToolCalling?: boolean,
	reasoningConfig?: ReasoningConfig,
) {
	// Convert Anthropic messages to OpenAI format
	let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
		{ role: "system", content: systemPrompt },
		...convertToOpenAiMessages(messages),
	]

	const isClaude1m =
		model.id === openRouterClaudeSonnet41mModelId ||
		model.id === openRouterClaudeSonnet451mModelId ||
		model.id === openRouterClaudeSonnet461mModelId ||
		model.id === openRouterClaudeOpus461mModelId ||
		model.id === openRouterClaudeOpus471mModelId
	if (isClaude1m) {
		// remove the custom :1m suffix, to create the model id openrouter API expects
		model.id = model.id.slice(0, -CLAUDE_SONNET_1M_SUFFIX.length)
	}

	// Sanitize messages for Gemini models (removes tool_calls without reasoning_details)
	openAiMessages = sanitizeGeminiMessages(openAiMessages, model.id)

	// prompt caching: https://openrouter.ai/docs/prompt-caching
	// Some OpenRouter models require cache_control blocks instead of automatic provider caching.
	// Other providers (OpenAI, Google) handle caching automatically without cache_control blocks.
	const needsCacheControl = needsExplicitCacheControl(model.id)

	if (needsCacheControl) {
		openAiMessages[0] = {
			role: "system",
			content: [
				{
					type: "text",
					text: systemPrompt,
					// @ts-expect-error-next-line
					cache_control: { type: "ephemeral" },
				},
			],
		}
		// Add cache_control to the last two user messages
		// (note: this works because we only ever add one user message at a time, but if we added multiple we'd need to mark the user message before the last assistant message)
		const lastTwoUserMessages = openAiMessages.filter((msg) => msg.role === "user").slice(-2)
		lastTwoUserMessages.forEach((msg) => {
			if (typeof msg.content === "string") {
				msg.content = [{ type: "text", text: msg.content }]
			}
			if (Array.isArray(msg.content)) {
				// NOTE: this is fine since env details will always be added at the end. but if it weren't there, and the user added a image_url type message, it would pop a text part before it and then move it after to the end.
				let lastTextPart = msg.content.filter((part) => part.type === "text").pop()

				if (!lastTextPart) {
					lastTextPart = { type: "text", text: "..." }
					msg.content.push(lastTextPart)
				}
				// @ts-expect-error-next-line
				lastTextPart.cache_control = { type: "ephemeral" }
			}
		})
	}

	let temperature: number | undefined = 0
	let topP: number | undefined
	if (
		model.id.startsWith("deepseek/deepseek-r1") ||
		model.id === "perplexity/sonar-reasoning" ||
		model.id === "qwen/qwq-32b:free" ||
		model.id === "qwen/qwq-32b"
	) {
		// Recommended values from DeepSeek
		temperature = 0.7
		topP = 0.95
		openAiMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
	}
	if (model.id.startsWith("google/gemini-3")) {
		// Recommended value from google
		temperature = 1.0
	}

	const reasoning = resolveOpenRouterReasoning(
		model.id,
		model.info.capabilities,
		reasoningConfig ?? { effort: reasoningEffort, thinkingBudget: thinkingBudgetTokens },
	)
	if (reasoning.omitSampling) {
		temperature = undefined
		topP = undefined
	}

	const providerPreferences = OPENROUTER_PROVIDER_PREFERENCES[model.id]
	if (providerPreferences) {
		openRouterProviderSorting = undefined
	}

	const includeReasoning = reasoning.enabled && !shouldSkipReasoningForModel(model.id)
	const maxTokens = isGeminiFlashModel(model.id)
		? Math.min(model.info.capabilities?.maxTokens || GEMINI_FLASH_MAX_OUTPUT_TOKENS, GEMINI_FLASH_MAX_OUTPUT_TOKENS)
		: undefined

	const requestPayload: Record<string, unknown> = {
		model: model.id,
		...(maxTokens ? { max_tokens: maxTokens } : {}),
		temperature: temperature,
		top_p: topP,
		messages: openAiMessages,
		stream: true,
		stream_options: { include_usage: true },
		include_reasoning: includeReasoning,
		...(reasoning.reasoning ? { reasoning: reasoning.reasoning } : {}),
		...(reasoning.verbosity ? { verbosity: reasoning.verbosity } : {}),
		...(openRouterProviderSorting && !providerPreferences ? { provider: { sort: openRouterProviderSorting } } : {}),
		...(providerPreferences ? { provider: providerPreferences } : {}),
		...(isClaude1m ? { provider: { order: ["anthropic", "google-vertex/global"], allow_fallbacks: false } } : {}),
		...getOpenAIToolParams(tools, !!enableParallelToolCalling),
	}

	// @ts-expect-error-next-line
	const stream = await client.chat.completions.create(requestPayload)

	return stream
}
