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

/** An image the message references where the user placed it and carries as its own block after the message. */
interface ReferencedImage {
    readonly part: AdmittedResourcePart
    readonly block: ClineImageContentBlock
}

/**
 * Builds the content of an admitted submission in the order the user composed it.
 *
 * Text and resources keep the order of the parts. An image stays where the
 * user placed it as an `<image_ref>` in the text, and its pixels follow the
 * message as a separate image block inside an `<image>` tag with the same id,
 * so the text reads whole and each image is named by the reference that
 * points at it. Other resources are inlined where they were placed.
 *
 * Each resource is read from the bytes admission verified, so a reopened task
 * sends the same content even when the file it came from changed or the temp
 * directory was cleaned. A resource that can no longer be read is replaced by
 * an explicit marker instead of vanishing, because the model would otherwise
 * answer as if the user attached nothing.
 */
export async function buildAdmittedInputContent(
    input: AdmittedInputContent,
    resources: AdmittedResourceReader | undefined,
): Promise<UserContentBlock[]> {
    const tag = input.opensTask ? "task" : "user_message"
    const context = input.context?.trim()
    const blocks: UserContentBlock[] = []
    appendText(blocks, `<${tag}>\n`)
    const images = await appendParts(blocks, input.parts, resources)
    if (context && !input.opensTask) appendText(blocks, `\n\n${context}`)
    appendText(blocks, `\n</${tag}>`)
    appendReferencedImages(blocks, images)
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
    const images = await appendParts(rendered, parts, resources)
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
    appendReferencedImages(blocks, images)
    return { blocks, documents }
}

/**
 * Appends each part where the user placed it: text as typed, an image as its
 * reference, any other resource as the blocks its bytes read as. Returns the
 * referenced images, whose blocks the caller sends after the message.
 */
async function appendParts(
    blocks: UserContentBlock[],
    parts: readonly AdmittedInputPart[],
    resources: AdmittedResourceReader | undefined,
): Promise<ReferencedImage[]> {
    const images: ReferencedImage[] = []
    for (const part of parts) {
        if (part.kind === "text") {
            appendText(blocks, part.text)
            continue
        }
        const content = await resourceContent(part, resources)
        if (content.kind === "image") {
            appendText(blocks, `<image_ref ${resourceAttributes(part)} />`)
            images.push({ part, block: content.block })
        } else {
            for (const block of content.blocks) appendBlock(blocks, block)
        }
    }
    return images
}

/** Sends each referenced image once, as its own block tagged with the id its references use. */
function appendReferencedImages<Block extends UserContentBlock>(blocks: Block[], images: readonly ReferencedImage[]): void {
    const sent = new Set<string>()
    for (const { part, block } of images) {
        if (sent.has(part.ref.resourceId)) continue
        sent.add(part.ref.resourceId)
        appendText(blocks, `\n<image ${resourceAttributes(part)}>\n`)
        appendBlock(blocks, block as Block)
        appendText(blocks, "\n</image>")
    }
}

type ResourceContent =
    | { readonly kind: "image"; readonly block: ClineImageContentBlock }
    | { readonly kind: "inline"; readonly blocks: UserContentBlock[] }

async function resourceContent(
    part: AdmittedResourcePart,
    resources: AdmittedResourceReader | undefined,
): Promise<ResourceContent> {
    const loaded = await resourceBytes(part, resources)
    if (loaded.kind === "inline") return loaded
    const { record, bytes } = loaded
    if (isInlineImageMediaType(record.mediaType)) {
        return {
            kind: "image",
            block: { type: "image", source: { type: "base64", media_type: record.mediaType, data: bytes.toString("base64") } },
        }
    }
    return { kind: "inline", blocks: await documentBlocks(part, record.mediaType, bytes) }
}

/** The verified bytes of a resource, or the marker that stands in for one that cannot be read. */
async function resourceBytes(
    part: AdmittedResourcePart,
    resources: AdmittedResourceReader | undefined,
): Promise<
    | { readonly kind: "bytes"; readonly record: { readonly mediaType: string }; readonly bytes: Buffer }
    | { readonly kind: "inline"; readonly blocks: UserContentBlock[] }
> {
    if (!resources) return { kind: "inline", blocks: [unavailableResource(part, "semantic_input_resource_open_failed")] }
    const loaded = await resources.readBytes(part.ref)
    if (!loaded.ok) return { kind: "inline", blocks: [unavailableResource(part, loaded.failure.code)] }
    return { kind: "bytes", ...loaded.value }
}

/** A non-image resource, inlined where the user placed it. */
async function documentBlocks(part: AdmittedResourcePart, mediaType: string, bytes: Buffer): Promise<UserContentBlock[]> {
    if (mediaType === OPAQUE_BINARY_MEDIA_TYPE) return [base64Resource(part, mediaType, bytes)]
    const extracted = await extractText(part, mediaType, bytes)
    if (extracted.kind === "unsupported") return [unavailableResource(part, "semantic_input_resource_invalid_mime")]
    // A document whose text could not be extracted is still sent: its
    // signature matched at admission, only the extractor rejected its content.
    const resourceText =
        extracted.kind === "text" ? attachedResource(part, extracted.text) : base64ResourceText(part, mediaType, bytes)
    if (mediaType !== PDF_MEDIA_TYPE) return [{ type: "text", text: resourceText }]
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
    return `<attached_resource ${resourceAttributes(part, extra)}>\n${content}\n</attached_resource>`
}

/** A resource's tag attributes; its identity is spread last so no extra attribute can rename it. */
function resourceAttributes(part: AdmittedResourcePart, extra: Readonly<Record<string, string>> = {}): string {
    const attributes = { ...extra, name: part.displayName, id: part.ref.resourceId }
    return Object.entries(attributes)
        .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
        .join(" ")
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
