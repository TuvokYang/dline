import { Anthropic } from "@anthropic-ai/sdk"
import {
	type DocumentInputLimits,
	isAttachedDocumentBlock,
	projectAttachedDocument,
	selectNativeDocuments,
} from "./attached-documents"
import { ClineMessageMetricsInfo, ClineMessageModelInfo } from "./metrics"
import { isForeignReasoningForAnthropic, isReasoningBlock } from "./reasoning-origin"

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

/** Image source accepted at replay/conversion boundaries, including provider-managed files. */
export type ClineReplayImageSource = ClineImageContentBlock["source"] | { type: "file"; file_id: string }

export function imageSourceToUrl(source: ClineReplayImageSource): string {
	if (source.type === "url") return source.url
	if (source.type === "base64") return `data:${source.media_type};base64,${source.data}`
	throw new Error("Provider file image sources cannot be replayed as URLs")
}

export function imageSourceMediaType(source: ClineReplayImageSource): string {
	if (source.type === "base64") return source.media_type
	return source.type === "url" ? "remote URL" : "provider file"
}

export interface ClineDocumentContentBlock extends Anthropic.DocumentBlockParam, ClineSharedMessageParam {
	/** Page count of a projected PDF, used only for context estimation and never sent to a provider. */
	page_count?: number
}

/**
 * A PDF the user attached, kept whole in history so each request can decide how to send it.
 *
 * Endpoints that read PDFs natively receive the bytes as a document within their documented size and page
 * limits; every other endpoint, and any PDF beyond those limits, receives `fallback_text`, the same
 * extracted `<file_content>` text attachments produced before native PDF input existed.
 */
export interface ClineUserAttachedDocumentBlock extends ClineSharedMessageParam {
	type: "attached_document"
	/** Path shown to the model, in POSIX form. */
	path: string
	media_type: "application/pdf"
	/** Base64-encoded file bytes. */
	data: string
	/** Decoded file size in bytes, so request budgets never decode `data`. */
	byte_length: number
	/** Page count reported by the PDF parser. */
	page_count?: number
	/** Extracted-text projection used when the PDF is not sent natively. */
	fallback_text: string
}

export interface ClineUserAgentsInstructionsContentBlock extends ClineSharedMessageParam {
	type: "agents_instructions"
	turn_id: string
	content: string
	sources: readonly {
		workspace_root_index: number
		path: string
		bytes: number
		truncated?: boolean
	}[]
	omitted_count?: number
	replaces_previous?: boolean
}

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

/** Wire protocols whose provider-hosted tool blocks can be replayed verbatim on a later request. */
export type HostedToolReplayProtocol = "anthropic_messages" | "openai_responses"

/**
 * Part of a hosted call that spans two assistant turns.
 *
 * Anthropic defers a hosted call grouped with a client tool call: the response that issued it ends without
 * a result (`call`), and the response to the request carrying the client tool results opens with that
 * result (`result`). The two halves pair by the provider call id, never by position.
 */
export type HostedToolReplaySegment = "call" | "result"

/**
 * One provider-hosted tool call, kept verbatim so a later request to the protocol that ran it
 * carries the call back to the model.
 *
 * `blocks` holds the provider-native items of that call in response order: Anthropic Messages stores the
 * `server_tool_use` block followed by its result block, OpenAI Responses stores the single output item
 * that records the call. No other protocol can interpret them, so every projection for a different
 * protocol drops the whole block.
 *
 * `segment` is absent for a call stored with its result. A deferred Anthropic call is stored as a `call`
 * segment in the turn that issued it and a `result` segment in the turn that received it.
 */
export interface ClineAssistantHostedToolBlock {
	type: "hosted_tool"
	protocol: HostedToolReplayProtocol
	segment?: HostedToolReplaySegment
	blocks: Array<Record<string, unknown>>
}

export type ClineToolResponseContent = ClinePromptInputContent | Array<ClineTextContentBlock | ClineImageContentBlock>

export type ClineUserContent =
	| ClineTextContentBlock
	| ClineImageContentBlock
	| ClineDocumentContentBlock
	| ClineUserToolResultContentBlock
	| ClineUserAgentsInstructionsContentBlock
	| ClineUserAttachedDocumentBlock

export type ClineAssistantContent =
	| ClineTextContentBlock
	| ClineImageContentBlock
	| ClineDocumentContentBlock
	| ClineAssistantToolUseBlock
	| ClineAssistantThinkingBlock
	| ClineAssistantRedactedThinkingBlock
	| ClineAssistantHostedToolBlock

export type ClineContent = ClineUserContent | ClineAssistantContent

export function isHostedToolBlock(block: ClineContent): block is ClineAssistantHostedToolBlock {
	return block.type === "hosted_tool"
}

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

export interface AnthropicMessageConversionOptions {
	/**
	 * Hosted tool names declared by the current request. A stored Anthropic hosted call is expanded back
	 * into its native call and result blocks only when its tool is in this set, so a request never
	 * references a hosted tool it does not declare. Endpoints that do not run Anthropic hosted tools
	 * leave this unset and every hosted block is dropped.
	 */
	replayHostedTools?: ReadonlySet<string>
	/**
	 * Provider call ids of deferred hosted segments this request must not carry, because the call can no
	 * longer be resumed or its result has lost its call. Complete hosted blocks are never omitted here.
	 */
	omitHostedCallIds?: ReadonlySet<string>
}

/** Native result block suffix Anthropic appends to the hosted tool name, as in `web_search_tool_result`. */
const ANTHROPIC_HOSTED_RESULT_SUFFIX = "_tool_result"

/**
 * Name of the hosted tool a stored replay block invokes.
 *
 * Read from its native `server_tool_use` call, or from the result block type when the block holds only the
 * result of a call deferred by an earlier turn.
 */
export function hostedToolName(block: ClineAssistantHostedToolBlock): string | undefined {
	const call = block.blocks.find((native) => native.type === "server_tool_use")
	if (call) return typeof call.name === "string" ? call.name : undefined
	if (block.segment !== "result") return undefined
	const resultType = block.blocks[0]?.type
	return typeof resultType === "string" && resultType.endsWith(ANTHROPIC_HOSTED_RESULT_SUFFIX)
		? resultType.slice(0, -ANTHROPIC_HOSTED_RESULT_SUFFIX.length)
		: undefined
}

/** Provider call id a deferred hosted segment belongs to; undefined for a complete hosted block. */
export function hostedSegmentCallId(block: ClineAssistantHostedToolBlock): string | undefined {
	const native = block.blocks[0]
	if (block.segment === "call") return typeof native?.id === "string" ? native.id : undefined
	if (block.segment === "result") return typeof native?.tool_use_id === "string" ? native.tool_use_id : undefined
	return undefined
}

function replaysHostedBlock(block: ClineAssistantHostedToolBlock, options: AnthropicMessageConversionOptions): boolean {
	if (block.protocol !== "anthropic_messages" || !options.replayHostedTools) return false
	const name = hostedToolName(block)
	if (name === undefined || !options.replayHostedTools.has(name)) return false
	const segmentCallId = hostedSegmentCallId(block)
	return segmentCallId === undefined || !options.omitHostedCallIds?.has(segmentCallId)
}

/**
 * Converts ClineStorageMessage to Anthropic.MessageParam by removing Cline-specific fields
 * Cline-specific fields (like modelInfo, reasoning_details) are properly omitted.
 */
export function convertClineStorageToAnthropicMessage(
	clineMessage: ClineStorageMessage,
	provider = "anthropic",
	options: AnthropicMessageConversionOptions = {},
): Anthropic.MessageParam {
	const { role, content } = clineMessage

	// Handle string content - fast path
	if (typeof content === "string") {
		return { role, content }
	}

	const filteredContent = content.filter(isReplayableToAnthropic)

	// Handle array content - strip Cline-specific fields for non-reasoning_details providers
	const shouldCleanContent = !REASONING_DETAILS_PROVIDERS.includes(provider)
	const cleanedContent = filteredContent.flatMap((block): Anthropic.ContentBlockParam[] => {
		if (isHostedToolBlock(block)) {
			return replaysHostedBlock(block, options) ? (block.blocks as unknown as Anthropic.ContentBlockParam[]) : []
		}
		return [
			shouldCleanContent || isAttachedDocumentBlock(block)
				? cleanContentBlock(block)
				: (block as Anthropic.ContentBlockParam),
		]
	})

	return { role, content: cleanedContent }
}

/**
 * Anthropic accepts only reasoning it issued: an unsigned `thinking` block cannot be verified, and
 * reasoning produced by another protocol carries ciphertext that Anthropic rejects.
 */
function isReplayableToAnthropic(block: ClineContent): boolean {
	if (!isReasoningBlock(block)) return true
	if (isForeignReasoningForAnthropic(block)) return false
	return block.type !== "thinking" || !!block.signature
}

export interface ProviderProjectionOptions {
	/** Hosted tool protocol the target endpoint replays; hosted blocks of any other protocol are dropped. */
	hostedToolReplayProtocol?: HostedToolReplayProtocol
	/** Native PDF capacity of the target endpoint; absent when it cannot read PDFs. */
	documentInput?: DocumentInputLimits
}

/**
 * Project Dline-internal content blocks into the shape every provider converter understands.
 *
 * Agents instructions become ordinary text, hosted tool blocks survive only for the protocol that can
 * replay them, and attached PDFs become native documents only within the endpoint's request budget, so no
 * converter ever receives a block type it cannot send.
 */
export function projectInternalMessagesForProvider(
	messages: readonly ClineStorageMessage[],
	options: ProviderProjectionOptions = {},
): ClineStorageMessage[] {
	const keepsHostedBlock = (block: ClineAssistantHostedToolBlock) => block.protocol === options.hostedToolReplayProtocol
	const nativeDocuments = selectNativeDocuments(messages, options.documentInput)
	return messages.map((message) => {
		if (
			!Array.isArray(message.content) ||
			!message.content.some(
				(block) =>
					block.type === "agents_instructions" ||
					isAttachedDocumentBlock(block) ||
					(isHostedToolBlock(block) && !keepsHostedBlock(block)),
			)
		) {
			return message
		}
		return {
			...message,
			content: message.content.flatMap((block): ClineContent[] => {
				if (block.type === "agents_instructions") return [{ type: "text", text: projectAgentsInstructionsText(block) }]
				if (isAttachedDocumentBlock(block)) {
					return projectAttachedDocument(block, nativeDocuments.has(block), options.documentInput)
				}
				if (isHostedToolBlock(block) && !keepsHostedBlock(block)) return []
				return [block]
			}),
		}
	})
}

export function projectAgentsInstructionsText(block: ClineUserAgentsInstructionsContentBlock): string {
	const safeContent = block.content.replaceAll("</agents_instructions>", "</agents_instructions>")
	const omitted = block.omitted_count ? ` omitted_scopes="${block.omitted_count}"` : ""
	const replacement = block.replaces_previous ? ' replaces_previous="true"' : ""
	return `<agents_instructions turn_id="${block.turn_id}"${omitted}${replacement}>\n${safeContent}\n</agents_instructions>`
}

export function cleanContentBlock(block: ClineContent): Anthropic.ContentBlockParam {
	if (block.type === "agents_instructions") {
		return { type: "text", text: projectAgentsInstructionsText(block) }
	}
	if (isAttachedDocumentBlock(block)) {
		// Only reachable when a caller skipped provider projection; text is the one form every endpoint reads.
		return { type: "text", text: block.fallback_text }
	}
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
		"page_count" in block ||
		(block.type !== "thinking" && "signature" in block)

	if (!hasClineFields) {
		return block as Anthropic.ContentBlockParam
	}

	// Removes Cline-specific fields & the signature field that's added for Gemini.
	const { reasoning_details, provider_metadata, call_id, item_id, function_id, dline_tid, summary, page_count, ...rest } =
		block as any

	// Remove signature from non-thinking blocks that were added for Gemini
	if (block.type !== "thinking" && rest.signature) {
		rest.signature = undefined
	}

	return rest satisfies Anthropic.ContentBlockParam
}
