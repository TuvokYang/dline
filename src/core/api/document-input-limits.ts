import type { ModelInfo } from "@shared/api"
import { PDF_MEDIA_TYPE } from "@shared/input-semantics/media-types"
import type { DocumentInputLimits } from "@shared/messages/attached-documents"
import { resolveInputMediaTypes } from "@shared/providers/input-media"

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
 * Whether the model reads PDFs natively, as its metadata declares.
 *
 * The API format only says a request *can* carry a PDF; whether this model reads one is a model
 * capability, so it is asked of the one capability resolver rather than decided per provider. This
 * keeps PDFs away from text-only models served through Anthropic- or OpenAI-compatible endpoints.
 */
function readsPdfNatively(info: ModelInfo): boolean {
    return resolveInputMediaTypes(info).has(PDF_MEDIA_TYPE)
}

/** Native PDF capacity of an Anthropic Messages request for this model; absent when the model reads no PDFs. */
export function anthropicMessagesDocumentLimits(info: ModelInfo): DocumentInputLimits | undefined {
    if (!readsPdfNatively(info)) return undefined
    const contextWindow = info.capabilities?.contextWindow ?? 0
    return {
        maxTotalBytes: decodedBytesFitting(ANTHROPIC_MAX_REQUEST_BYTES - ANTHROPIC_NON_DOCUMENT_HEADROOM_BYTES),
        maxTotalPages:
            contextWindow >= ANTHROPIC_LARGE_CONTEXT_TOKENS ? ANTHROPIC_MAX_PAGES : ANTHROPIC_MAX_PAGES_UNDER_LARGE_CONTEXT,
    }
}

/** Native PDF capacity of an OpenAI Responses request for this model; absent when the model reads no PDFs. */
export function openAiResponsesDocumentLimits(info: ModelInfo): DocumentInputLimits | undefined {
    if (!readsPdfNatively(info)) return undefined
    return { maxTotalBytes: OPENAI_MAX_TOTAL_FILE_BYTES }
}
