import { Anthropic } from "@anthropic-ai/sdk"
import { ClineMessageMetricsInfo, ClineMessageModelInfo } from "./metrics"

export type ClinePromptInputContent = string

export type ClineMessageRole = "user" | "assistant"

export interface ClineReasoningDetailParam {
	type: "reasoning.text" | string
	text: string
	signature: string
	format: "anthropic-claude-v1" | string
	index: number
}

/** Provider-owned replay metadata that must never be used as runtime identity. */
export interface ClineProviderMetadata {
	/** Provider content item identity, for example an OpenAI Responses `fc_*` id. */
	item_id?: string
	/** Provider response/message/reasoning identity used only for protocol replay. */
	response_id?: string
}

interface ClineSharedMessageParam {
	/** Opaque provider transport metadata, isolated from Dline runtime identity. */
	provider_metadata?: ClineProviderMetadata
}

export const REASONING_DETAILS_PROVIDERS = ["cline", "openrouter"]

/**
 * An extension of Anthropic.MessageParam that includes Cline-specific fields: reasoning_details.
 * This ensures backward compatibility where the messages were stored in Anthropic format with additional
 * fields unknown to Anthropic SDK.
 */
export interface ClineTextContentBlock extends Anthropic.TextBlockParam, ClineSharedMessageParam {
	// reasoning_details only exists for providers listed in REASONING_DETAILS_PROVIDERS
	reasoning_details?: ClineReasoningDetailParam[]
	// Thought Signature associates with Gemini
	signature?: string
}

export interface ClineImageContentBlock extends Anthropic.ImageBlockParam, ClineSharedMessageParam {}

export function imageSourceToUrl(source: ClineImageContentBlock["source"]): string {
	if (source.type === "url") return source.url
	if (source.type === "base64") return `data:${source.media_type};base64,${source.data}`
	throw new Error("Provider file image sources cannot be converted to portable URLs")
}

export function imageSourceMediaType(source: ClineImageContentBlock["source"]): string {
	if (source.type === "base64") return source.media_type
	return source.type === "url" ? "remote URL" : "provider file"
}

export interface ClineDocumentContentBlock extends Anthropic.DocumentBlockParam, ClineSharedMessageParam {}

export interface ClineUserToolResultContentBlock extends ClineSharedMessageParam {
	type: "tool_result"
	/** The only canonical tool-use/result pairing identity. */
	function_id: string
	/** The only canonical Dline runtime lifecycle identity. */
	dline_tid: string
	content: ClineToolResponseContent
	is_error?: boolean
}

/**
 * Assistant only content types
 */
export interface ClineAssistantToolUseBlock extends ClineSharedMessageParam {
	type: "tool_use"
	/** The only canonical tool-use/result pairing identity. */
	function_id: string
	/** The only canonical Dline runtime lifecycle identity. */
	dline_tid: string
	name: string
	input: unknown
	// reasoning_details only exists for providers listed in REASONING_DETAILS_PROVIDERS
	reasoning_details?: unknown[] | ClineReasoningDetailParam[]
	// Thought Signature associates with Gemini
	signature?: string
}

export interface ClineAssistantThinkingBlock extends Anthropic.ThinkingBlock, ClineSharedMessageParam {
	// The summary items returned by OpenAI response API
	// The reasoning details that will be moved to the text block when finalized
	summary?: unknown[] | ClineReasoningDetailParam[]
}

export interface ClineAssistantRedactedThinkingBlock extends Anthropic.RedactedThinkingBlockParam, ClineSharedMessageParam {}

export type ClineToolResponseContent = ClinePromptInputContent | Array<ClineTextContentBlock | ClineImageContentBlock>

export type ClineUserContent =
	| ClineTextContentBlock
	| ClineImageContentBlock
	| ClineDocumentContentBlock
	| ClineUserToolResultContentBlock

export type ClineAssistantContent =
	| ClineTextContentBlock
	| ClineImageContentBlock
	| ClineDocumentContentBlock
	| ClineAssistantToolUseBlock
	| ClineAssistantThinkingBlock
	| ClineAssistantRedactedThinkingBlock

export type ClineContent = ClineUserContent | ClineAssistantContent

/**
 * An extension of Anthropic.MessageParam that includes Cline-specific fields.
 * This ensures backward compatibility where the messages were stored in Anthropic format,
 * while allowing for additional metadata specific to Cline to avoid unknown fields in Anthropic SDK
 * added by ignoring the type checking for those fields.
 */
export interface ClineStorageMessage {
	role: ClineMessageRole
	content: ClinePromptInputContent | ClineContent[]
	/** Provider transport metadata, isolated from Dline runtime identity. */
	provider_metadata?: ClineProviderMetadata
	/**
	 * NOTE: model information used when generating this message.
	 * Internal use for message conversion only.
	 * MUST be removed before sending message to any LLM provider.
	 */
	modelInfo?: ClineMessageModelInfo
	/**
	 * LLM operational and performance metrics for this message
	 * Includes token counts, costs.
	 */
	metrics?: ClineMessageMetricsInfo
	/**
	 * Timestamp of when the message was created
	 */
	ts?: number
}

/**
 * Converts ClineStorageMessage to Anthropic.MessageParam by removing Cline-specific fields
 * Cline-specific fields (like modelInfo, reasoning_details) are properly omitted.
 */
export function convertClineStorageToAnthropicMessage(
	clineMessage: ClineStorageMessage,
	provider = "anthropic",
): Anthropic.MessageParam {
	const { role, content } = clineMessage

	// Handle string content - fast path
	if (typeof content === "string") {
		return { role, content }
	}

	// Removes thinking block that has no signature (invalid thinking block that's incompatible with Anthropic API)
	const filteredContent = content.filter((b) => b.type !== "thinking" || !!b.signature)

	// Handle array content - strip Cline-specific fields for non-reasoning_details providers
	const shouldCleanContent = !REASONING_DETAILS_PROVIDERS.includes(provider)
	const cleanedContent = shouldCleanContent
		? filteredContent.map(cleanContentBlock)
		: (filteredContent as Anthropic.MessageParam["content"])

	return { role, content: cleanedContent }
}

/**
 * Clean a content block by removing Cline-specific fields and returning only Anthropic-compatible fields
 */
export function cleanContentBlock(block: ClineContent): Anthropic.ContentBlockParam {
	if (block.type === "tool_use") {
		if (!block.function_id || !block.dline_tid) {
			throw new Error("Canonical tool_use is missing function_id or dline_tid")
		}
		return {
			type: "tool_use",
			id: block.function_id,
			name: block.name,
			input: block.input,
		} satisfies Anthropic.ToolUseBlockParam
	}
	if (block.type === "tool_result") {
		if (!block.function_id || !block.dline_tid) {
			throw new Error("Canonical tool_result is missing function_id or dline_tid")
		}
		return {
			type: "tool_result",
			tool_use_id: block.function_id,
			content: block.content,
			...(block.is_error === undefined ? {} : { is_error: block.is_error }),
		} satisfies Anthropic.ToolResultBlockParam
	}

	// Fast path: if no Cline-specific fields exist, return as-is
	const hasClineFields =
		"reasoning_details" in block ||
		"provider_metadata" in block ||
		"call_id" in block ||
		"item_id" in block ||
		"function_id" in block ||
		"dline_tid" in block ||
		"summary" in block ||
		(block.type !== "thinking" && "signature" in block)

	if (!hasClineFields) {
		return block as Anthropic.ContentBlockParam
	}

	// Removes Cline-specific fields & the signature field that's added for Gemini.
	const { reasoning_details, provider_metadata, call_id, item_id, function_id, dline_tid, summary, ...rest } = block as any

	// Remove signature from non-thinking blocks that were added for Gemini
	if (block.type !== "thinking" && rest.signature) {
		rest.signature = undefined
	}

	return rest satisfies Anthropic.ContentBlockParam
}
