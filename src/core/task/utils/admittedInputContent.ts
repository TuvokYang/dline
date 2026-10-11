import { extractResourceText, UnsupportedResourceMediaTypeError } from "@integrations/misc/extract-resource-text"
import { fitsBase64TextLimit } from "@shared/attachments"
import type { AdmittedInputPart, AdmittedResourcePart } from "@shared/input-semantics/admitted-parts"
import type { SemanticResourceRef } from "@shared/input-semantics/document"
import {
    INLINE_IMAGE_MEDIA_TYPES,
    isInlineImageMediaType,
    OPAQUE_BINARY_MEDIA_TYPE,
    PDF_MEDIA_TYPE,
} from "@shared/input-semantics/media-types"
import type { ClineImageContentBlock, ClineTextContentBlock, ClineUserAttachedDocumentBlock } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { type ToolApprovalFeedbackContent, toolApprovalFeedbackText } from "./buildUserFeedbackContent"

type UserContentBlock = ClineTextContentBlock | ClineImageContentBlock | ClineUserAttachedDocumentBlock

/** Fails to compile when an inline image format is one the image block cannot carry. */
const _INLINE_IMAGES_FIT_IMAGE_BLOCK: readonly Extract<ClineImageContentBlock["source"], { type: "base64" }>["media_type"][] =
    INLINE_IMAGE_MEDIA_TYPES

/**
 * Reads the bytes of one admitted resource.
 *
 * Declared here, by the consumer, so the projection depends on nothing but the
 * guarantee it needs. The reference's identity, owner and generation are always
 * checked; what the bytes are depends on how the resource was admitted:
 *
 * - a captured resource (pasted content, kept in task tmp) returns exactly the
 *   bytes whose hash was frozen at admission;
 * - a linked resource (a picked or dropped local file) returns what the file
 *   holds now, refused as changed if it no longer has the media type recorded
 *   for it or no longer resolves to the file it was linked to.
 *
 * A linked resource therefore makes a replayed request follow later edits of
 * the file; that is the user's chosen semantics for local paths, not a lapse.
 */
export interface AdmittedResourceReader {
    readBytes(ref: SemanticResourceRef): Promise<
        | {
              readonly ok: true
              readonly value: { readonly record: { readonly mediaType: string }; readonly bytes: Buffer }
          }
        | { readonly ok: false; readonly failure: { readonly code: string } }
    >
}

/** What one admitted submission needs to become provider content. */
export interface AdmittedInputContent {
    readonly parts: readonly AdmittedInputPart[]
    /** Submission context such as a TaskStart hook or a spawn handoff; never what the user typed. */
    readonly context?: string
    /** The submission that opened the task is the `<task>`; every other one a `<user_message>`. */
    readonly opensTask: boolean
}

/**
 * Builds the content of an admitted submission in the order the user composed it.
 *
 * Text and resources interleave exactly as the parts do: an image placed between
 * two sentences is sent between them. Each resource is read from the bytes
 * admission verified, so a reopened task sends the same content even when the
 * file it came from changed or the temp directory was cleaned. A resource that
 * can no longer be read is replaced by an explicit marker instead of vanishing,
 * because the model would otherwise answer as if the user attached nothing.
 */
export async function buildAdmittedInputContent(
    input: AdmittedInputContent,
    resources: AdmittedResourceReader | undefined,
): Promise<UserContentBlock[]> {
    const tag = input.opensTask ? "task" : "user_message"
    const context = input.context?.trim()
    const blocks: UserContentBlock[] = []
    appendText(blocks, `<${tag}>\n`)
    await appendParts(blocks, input.parts, resources)
    if (context && !input.opensTask) appendText(blocks, `\n\n${context}`)
    appendText(blocks, `\n</${tag}>`)
    if (context && input.opensTask) blocks.push({ type: "text", text: `<context>\n${context}\n</context>` })
    return blocks
}

/**
 * Builds what an admitted approval note adds to the result of the tool call it answered.
 *
 * The note keeps the order the user composed it in, as a submission does, but
 * reads as feedback on that call. A PDF cannot travel inside a tool result, so
 * its native document follows the results, as a legacy attached PDF does.
 */
export async function buildAdmittedToolApprovalFeedbackContent(
    parts: readonly AdmittedInputPart[],
    resources: AdmittedResourceReader | undefined,
): Promise<ToolApprovalFeedbackContent> {
    const rendered: UserContentBlock[] = []
    await appendParts(rendered, parts, resources)
    if (rendered.length === 0) return { blocks: [], documents: [] }
    const typed = parts.some((part) => part.kind === "text" && part.text.trim().length > 0)
    const blocks: Array<ClineTextContentBlock | ClineImageContentBlock> = []
    const documents: ClineUserAttachedDocumentBlock[] = []
    appendText(
        blocks,
        typed ? "The user provided the following feedback:\n<feedback>\n" : `${toolApprovalFeedbackText(undefined)}\n`,
    )
    for (const block of rendered) {
        if (block.type === "attached_document") documents.push(block)
        else appendBlock(blocks, block)
    }
    if (typed) appendText(blocks, "\n</feedback>")
    return { blocks, documents }
}

/** Appends each part where the user placed it: text as typed, each resource as the blocks its bytes read as. */
async function appendParts(
    blocks: UserContentBlock[],
    parts: readonly AdmittedInputPart[],
    resources: AdmittedResourceReader | undefined,
): Promise<void> {
    for (const part of parts) {
        if (part.kind === "text") appendText(blocks, part.text)
        else for (const block of await resourceBlocks(part, resources)) appendBlock(blocks, block)
    }
}

async function resourceBlocks(
    part: AdmittedResourcePart,
    resources: AdmittedResourceReader | undefined,
): Promise<UserContentBlock[]> {
    if (!resources) return [unavailableResource(part, "semantic_input_resource_open_failed")]
    const loaded = await resources.readBytes(part.ref)
    if (!loaded.ok) return [unavailableResource(part, loaded.failure.code)]
    const { record, bytes } = loaded.value
    if (isInlineImageMediaType(record.mediaType)) {
        return [{ type: "image", source: { type: "base64", media_type: record.mediaType, data: bytes.toString("base64") } }]
    }
    if (record.mediaType === OPAQUE_BINARY_MEDIA_TYPE) return [base64Resource(part, record.mediaType, bytes)]
    const extracted = await extractText(part, record.mediaType, bytes)
    if (extracted.kind === "unsupported") return [unavailableResource(part, "semantic_input_resource_invalid_mime")]
    // A document whose text could not be extracted is still sent: its
    // signature matched at admission, only the extractor rejected its content.
    const resourceText =
        extracted.kind === "text" ? attachedResource(part, extracted.text) : base64ResourceText(part, record.mediaType, bytes)
    if (record.mediaType !== PDF_MEDIA_TYPE) return [{ type: "text", text: resourceText }]
    // The native document and its fallback come from the same bytes, so
    // whichever one a request sends describes the same attachment.
    return [
        {
            type: "attached_document",
            path: part.displayName,
            media_type: PDF_MEDIA_TYPE,
            data: bytes.toString("base64"),
            byte_length: bytes.byteLength,
            ...(extracted.kind === "text" && extracted.pageCount !== undefined ? { page_count: extracted.pageCount } : {}),
            fallback_text: resourceText,
        },
    ]
}

type ExtractionOutcome =
    | { readonly kind: "text"; readonly text: string; readonly pageCount?: number }
    | { readonly kind: "unreadable" }
    | { readonly kind: "unsupported" }

/** Separates content the extractor rejected from a media type no extractor exists for, which is a code gap. */
async function extractText(part: AdmittedResourcePart, mediaType: string, bytes: Buffer): Promise<ExtractionOutcome> {
    try {
        const extracted = await extractResourceText(mediaType, bytes)
        return { kind: "text", text: extracted.text, pageCount: extracted.pageCount }
    } catch (error) {
        if (error instanceof UnsupportedResourceMediaTypeError) {
            Logger.error(`[AdmittedInput] resource ${part.entityId} has media type ${mediaType}, which no extractor reads`)
            return { kind: "unsupported" }
        }
        Logger.warn(`[AdmittedInput] resource ${part.entityId} could not be read as ${mediaType}: ${errorName(error)}`)
        return { kind: "unreadable" }
    }
}

/** Content no reader understands, sent whole as base64 text. */
function base64Resource(part: AdmittedResourcePart, mediaType: string, bytes: Buffer): ClineTextContentBlock {
    return { type: "text", text: base64ResourceText(part, mediaType, bytes) }
}

/**
 * Admission already refused opaque content whose base64 exceeds its budget;
 * the check here covers a document whose extractor rejected it, whose size was
 * judged against its own format's limit when it was admitted.
 */
function base64ResourceText(part: AdmittedResourcePart, mediaType: string, bytes: Buffer): string {
    if (!fitsBase64TextLimit(bytes.byteLength)) return unavailableResource(part, "semantic_input_resource_too_large").text
    return attachedResource(part, bytes.toString("base64"), { media_type: mediaType, encoding: "base64" })
}

/** An explicit stand-in for a resource that cannot be sent; names the failure, never a path or its content. */
function unavailableResource(part: AdmittedResourcePart, code: string): ClineTextContentBlock {
    Logger.warn(`[AdmittedInput] resource ${part.entityId} is unavailable: ${code}`)
    return { type: "text", text: attachedResource(part, `[The attached resource is unavailable: ${code}]`) }
}

/**
 * Wraps an attachment's text in its own tag.
 *
 * Not `<file_content path=…>`: context management folds repeated reads of the
 * same workspace path into a notice, and two attachments that only share a
 * display name are different content that must both reach the model.
 */
function attachedResource(part: AdmittedResourcePart, content: string, extra: Readonly<Record<string, string>> = {}): string {
    // Identity is spread last so no extra attribute can rename the resource.
    const attributes = { ...extra, name: part.displayName, id: part.ref.resourceId }
    const rendered = Object.entries(attributes)
        .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
        .join(" ")
    return `<attached_resource ${rendered}>\n${content}\n</attached_resource>`
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : "unknown error"
}

/** Merge adjacent text so the interleaving adds no empty seams between blocks. */
function appendText<Block extends UserContentBlock>(blocks: Block[], text: string): void {
    if (text.length === 0) return
    appendBlock(blocks, { type: "text", text } as Block)
}

function appendBlock<Block extends UserContentBlock>(blocks: Block[], block: Block): void {
    const last = blocks.at(-1)
    if (block.type === "text" && last?.type === "text") {
        blocks[blocks.length - 1] = { ...last, text: last.text + block.text }
        return
    }
    blocks.push(block)
}
