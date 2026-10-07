import type { ModelInfo } from "@shared/api"
import type { DocumentInputLimits } from "@shared/messages/attached-documents"

const MEGABYTE = 1000 * 1000

/** Anthropic Messages caps the entire request, PDFs included, at 32 MB of encoded payload. */
const ANTHROPIC_MAX_REQUEST_BYTES = 32 * MEGABYTE
/** Encoded room kept for the system prompt, tools, and conversation sent alongside the PDFs. */
const ANTHROPIC_NON_DOCUMENT_HEADROOM_BYTES = 2 * MEGABYTE
/** Anthropic allows 600 PDF pages per request, or 100 when the request's context window is under 1M tokens. */
const ANTHROPIC_LARGE_CONTEXT_TOKENS = 1_000_000
const ANTHROPIC_MAX_PAGES = 600
const ANTHROPIC_MAX_PAGES_UNDER_LARGE_CONTEXT = 100
/** OpenAI file inputs: each file under 50 MB and at most 50 MB across all files in one request. */
const OPENAI_MAX_TOTAL_FILE_BYTES = 50 * MEGABYTE

/** Decoded bytes whose base64 encoding fits in `encodedBytes`. */
function decodedBytesFitting(encodedBytes: number): number {
	return Math.floor((encodedBytes * 3) / 4)
}

/**
 * Native PDF capacity of an Anthropic Messages request for this model.
 *
 * PDF pages are read as images, so a model without image input never receives a PDF natively; this also
 * keeps PDFs away from non-Claude models served through Anthropic-compatible endpoints.
 */
export function anthropicMessagesDocumentLimits(info: ModelInfo): DocumentInputLimits | undefined {
	if (info.capabilities?.supportsImages !== true) return undefined
	const contextWindow = info.capabilities.contextWindow ?? 0
	return {
		maxTotalBytes: decodedBytesFitting(ANTHROPIC_MAX_REQUEST_BYTES - ANTHROPIC_NON_DOCUMENT_HEADROOM_BYTES),
		maxTotalPages:
			contextWindow >= ANTHROPIC_LARGE_CONTEXT_TOKENS ? ANTHROPIC_MAX_PAGES : ANTHROPIC_MAX_PAGES_UNDER_LARGE_CONTEXT,
	}
}

/** Native PDF capacity of an OpenAI Responses request; PDF page images require a vision-capable model. */
export function openAiResponsesDocumentLimits(info: ModelInfo): DocumentInputLimits | undefined {
	if (info.capabilities?.supportsImages !== true) return undefined
	return { maxTotalBytes: OPENAI_MAX_TOTAL_FILE_BYTES }
}
