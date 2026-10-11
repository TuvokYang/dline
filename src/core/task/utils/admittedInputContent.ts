import { extractResourceText, PDF_MEDIA_TYPE } from "@integrations/misc/extract-resource-text"
import type { AdmittedInputPart, AdmittedResourcePart } from "@shared/input-semantics/admitted-parts"
import type { SemanticResourceRef } from "@shared/input-semantics/document"
import type { ClineImageContentBlock, ClineTextContentBlock, ClineUserAttachedDocumentBlock } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"

type UserContentBlock = ClineTextContentBlock | ClineImageContentBlock | ClineUserAttachedDocumentBlock
type InlineImageMediaType = Extract<ClineImageContentBlock["source"], { type: "base64" }>["media_type"]

/** The image formats sent inline; they match what the input resource classifier admits as an image. */
const INLINE_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<InlineImageMediaType>(["image/png", "image/jpeg", "image/webp"])

function isInlineImageMediaType(mediaType: string): mediaType is InlineImageMediaType {
    return INLINE_IMAGE_MEDIA_TYPES.has(mediaType)
}

/**
 * Reads the bytes admission verified for one resource.
 *
 * Declared here, by the consumer, so the projection depends on nothing but the
 * guarantee it needs: the bytes returned are exactly the ones whose identity,
 * owner and hash were checked, together with the media type recorded for them.
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
    for (const part of input.parts) {
        if (part.kind === "text") appendText(blocks, part.text)
        else for (const block of await resourceBlocks(part, resources)) appendBlock(blocks, block)
    }
    if (context && !input.opensTask) appendText(blocks, `\n\n${context}`)
    appendText(blocks, `\n</${tag}>`)
    if (context && input.opensTask) blocks.push({ type: "text", text: `<context>\n${context}\n</context>` })
    return blocks
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
    try {
        const extracted = await extractResourceText(record.mediaType, bytes)
        const resourceText = attachedResource(part, extracted.text)
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
                ...(extracted.pageCount === undefined ? {} : { page_count: extracted.pageCount }),
                fallback_text: resourceText,
            },
        ]
    } catch (error) {
        Logger.warn(`[AdmittedInput] resource ${part.entityId} could not be read as ${record.mediaType}: ${errorName(error)}`)
        return [unavailableResource(part, "semantic_input_resource_invalid_mime")]
    }
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
function attachedResource(part: AdmittedResourcePart, content: string): string {
    const name = escapeAttribute(part.displayName)
    const id = escapeAttribute(part.ref.resourceId)
    return `<attached_resource name="${name}" id="${id}">\n${content}\n</attached_resource>`
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : "unknown error"
}

/** Merge adjacent text so the interleaving adds no empty seams between blocks. */
function appendText(blocks: UserContentBlock[], text: string): void {
    if (text.length === 0) return
    appendBlock(blocks, { type: "text", text })
}

function appendBlock(blocks: UserContentBlock[], block: UserContentBlock): void {
    const last = blocks.at(-1)
    if (block.type === "text" && last?.type === "text") {
        blocks[blocks.length - 1] = { ...last, text: last.text + block.text }
        return
    }
    blocks.push(block)
}
