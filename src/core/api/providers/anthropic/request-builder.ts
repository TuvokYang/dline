import type { Tool as AnthropicTool, TextBlockParam } from "@anthropic-ai/sdk/resources/index"
import type { MessageCreateParamsStreaming, MessageParam } from "@anthropic-ai/sdk/resources/messages/messages"
import type { ModelInfo } from "@shared/api"
import type { ClineStorageMessage } from "@/shared/messages/content"
import type { ApiRequestOptions } from "../../index"
import { sanitizeAnthropicMessages } from "../../transform/anthropic-format"
import { declaredAnthropicHostedToolNames, mergeAnthropicServerTools } from "../../utils/messages_api_support"
import type { AnthropicReasoning } from "./reasoning"

/** Output budget used when neither the request nor the model declares one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192

export type AnthropicMessagesRequestBody = MessageCreateParamsStreaming & Record<string, unknown>

/**
 * Whether a request that declares local tools may force the model to call one.
 *
 * - `model_declared`: force unless the model declares it rejects forcing, a hosted tool is merged, or thinking is on.
 * - `never`: always leave the choice to the model.
 */
export type AnthropicForcedToolChoice = "model_declared" | "never"

export interface AnthropicMessagesRequestInput {
	/** Model identifier sent to the API, including any tier suffix. */
	model: string
	modelInfo: ModelInfo
	systemPrompt: string
	/** Blocks that lead the system array, such as a client attribution block. They never carry a cache breakpoint. */
	systemPrefix?: readonly TextBlockParam[]
	/** Messages already prepared by {@link prepareAnthropicMessages}. */
	messages: MessageParam[]
	reasoning: AnthropicReasoning
	tools?: readonly AnthropicTool[]
	options?: ApiRequestOptions
	forcedToolChoice: AnthropicForcedToolChoice
}

/** Whether the model accepts prompt-cache breakpoints, which also shapes message conversion. */
export function anthropicPromptCacheOn(modelInfo: ModelInfo): boolean {
	return modelInfo.capabilities?.supportsPromptCache === true
}

/**
 * Convert stored history into Messages API parameters for one request.
 *
 * Stored hosted calls are replayed only for hosted tools this same request declares.
 */
export function prepareAnthropicMessages(
	messages: ClineStorageMessage[],
	modelInfo: ModelInfo,
	options?: ApiRequestOptions,
): MessageParam[] {
	return sanitizeAnthropicMessages(messages, anthropicPromptCacheOn(modelInfo), {
		replayHostedTools: declaredAnthropicHostedToolNames(options?.serverTools),
	})
}

/** Build the single streaming Messages API request body shared by every Anthropic Messages provider. */
export function buildAnthropicMessagesRequest(input: AnthropicMessagesRequestInput): AnthropicMessagesRequestBody {
	const { reasoning } = input
	const promptCacheOn = anthropicPromptCacheOn(input.modelInfo)
	const requestTools = mergeAnthropicServerTools(input.tools, input.options?.serverTools)
	const toolChoice = resolveToolChoice(input)

	const body: AnthropicMessagesRequestBody = {
		model: input.model,
		max_tokens: resolveMaxOutputTokens(input.modelInfo, input.options),
		// "Thinking isn't compatible with temperature, top_p, or top_k modifications as well as forced tool use."
		// (https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking#important-considerations-when-using-extended-thinking)
		// Adaptive Claude models do not support temperature.
		temperature: reasoning.adaptive || reasoning.enabled ? undefined : 0,
		// The prefix leads the system array, matching real client traffic. The cache breakpoint stays on the
		// system prompt, so a new task reuses the cached prefix. Tools are not given their own breakpoint:
		// breakpoints apply tools > system > messages, and a tools-only breakpoint misses the minimum cacheable size.
		system: [
			...(input.systemPrefix ?? []),
			{
				type: "text",
				text: input.systemPrompt,
				...(promptCacheOn ? { cache_control: { type: "ephemeral" as const } } : {}),
			},
		],
		messages: input.messages,
		stream: true,
		...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
		...(requestTools ? { tools: requestTools } : {}),
		...(toolChoice ? { tool_choice: toolChoice } : {}),
	}
	if (reasoning.outputConfig) {
		body.output_config = reasoning.outputConfig
	}
	return body
}

function resolveMaxOutputTokens(modelInfo: ModelInfo, options?: ApiRequestOptions): number {
	return options?.generation?.purpose === "compaction"
		? options.generation.maxOutputTokens
		: modelInfo.capabilities?.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS
}

/**
 * Choose the tool policy for a request.
 *
 * Only local tools warrant a choice; a request that declares none leaves the field out. `tool_choice: any`
 * only admits client tools, so forcing it while a hosted tool is merged would make that tool unreachable.
 * A model that rejects forcing fails the whole request rather than degrading, so its own declaration
 * decides this. Manual extended thinking cannot be combined with a forced choice, which leaves the API default.
 */
function resolveToolChoice(input: AnthropicMessagesRequestInput): MessageCreateParamsStreaming["tool_choice"] {
	if (!input.tools?.length) return undefined
	const hostedServerToolsOn = (input.options?.serverTools?.length ?? 0) > 0
	const forcingAllowed =
		input.forcedToolChoice === "model_declared" && input.modelInfo.capabilities?.supportsForcedToolUse !== false
	if (hostedServerToolsOn || !forcingAllowed) return { type: "auto" }
	return input.reasoning.enabled ? undefined : { type: "any" }
}
