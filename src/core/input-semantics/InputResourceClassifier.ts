import {
    attachmentExtension,
    fitsBase64TextLimit,
    formatAttachmentLimit,
    isAttachableImageName,
    MAX_ATTACHED_BASE64_TEXT_BYTES,
    MAX_ATTACHED_PDF_BYTES,
    MAX_ATTACHED_TEXT_FILE_BYTES,
    maxAttachmentBytes,
} from "@shared/attachments"
import { formatBytes } from "@shared/content-limits"
import {
    DOCX_MEDIA_TYPE,
    type InlineImageMediaType,
    NOTEBOOK_MEDIA_TYPE,
    OPAQUE_BINARY_MEDIA_TYPE,
    PDF_MEDIA_TYPE,
    PLAIN_TEXT_MEDIA_TYPE,
    XLSX_MEDIA_TYPE,
} from "@shared/input-semantics/media-types"
import { countTextLines } from "@shared/input-semantics/resource-policy"
import sizeOf from "image-size"
import { isBinaryFile } from "isbinaryfile"
import { type InputResourceResult, resourceFailed, resourceSucceeded } from "./InputResourceFailure"

/** What an input resource is to the composer and the provider. */
export type InputResourceKind = "image" | "file" | "pasted_text"

export const INPUT_RESOURCE_KINDS: readonly InputResourceKind[] = ["image", "file", "pasted_text"]

/** What a resource's bytes were verified to be. */
export interface InputResourceClassification {
    readonly kind: InputResourceKind
    readonly mediaType: string
    /** Logical lines, present only for content read as text. */
    readonly lineCount?: number
}

/** Largest image edge providers accept as inline image input. */
export const MAX_INPUT_IMAGE_DIMENSION_PX = 7680

/** Inline image formats keyed by the format `image-size` detects from the bytes. */
export const IMAGE_MEDIA_TYPE_BY_DETECTED_FORMAT: Readonly<Record<string, InlineImageMediaType>> = {
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp",
}

const ZIP_SIGNATURE = Uint8Array.from([0x50, 0x4b, 0x03, 0x04])

/** Binary documents are accepted only when their bytes start with their container signature. */
const DOCUMENT_FORMAT_BY_EXTENSION: Readonly<Record<string, { readonly mediaType: string; readonly signature: Uint8Array }>> = {
    pdf: { mediaType: PDF_MEDIA_TYPE, signature: new TextEncoder().encode("%PDF-") },
    docx: { mediaType: DOCX_MEDIA_TYPE, signature: ZIP_SIGNATURE },
    xlsx: { mediaType: XLSX_MEDIA_TYPE, signature: ZIP_SIGNATURE },
}

/** Text formats with a specific media type; every other text file is plain text. */
const TEXT_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
    md: "text/markdown",
    markdown: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    ipynb: NOTEBOOK_MEDIA_TYPE,
}

/**
 * Decide what one named file's bytes are, or why they cannot be attached.
 *
 * This is the only place a media type is assigned to input content. The name
 * selects which format to expect; the bytes must then prove it, so a renamed
 * file is never sent to a provider under a type it does not have. An image's
 * media type comes from its detected format rather than its extension, because
 * providers decode by the declared type.
 *
 * Content is never refused for its type. Bytes that prove no readable format
 * (an executable, a presentation, a renamed or damaged document) are opaque
 * binary, which the model receives whole as base64 text; such content is
 * refused only when that text would exceed its budget, so the refusal happens
 * here rather than at request time. Size is checked twice: the name selects
 * the ceiling applied before the bytes are inspected, and the format the bytes
 * prove selects the limit that finally applies.
 */
export async function classifyInputFile(
    displayName: string,
    bytes: Uint8Array,
): Promise<InputResourceResult<InputResourceClassification>> {
    if (bytes.byteLength > maxAttachmentBytes(displayName)) {
        return resourceFailed(
            "semantic_input_resource_too_large",
            `${displayName} exceeds the ${formatAttachmentLimit(displayName)} attachment limit`,
        )
    }
    const image = isAttachableImageName(displayName) ? classifyImage(displayName, bytes) : undefined
    if (image) return image
    const recognized = recognizeDocument(displayName, bytes) ?? (await recognizeText(displayName, bytes))
    return recognized ? withinFormatLimit(displayName, bytes, recognized) : classifyOpaqueBinary(displayName, bytes)
}

/** Classify text the user pasted; its size is checked against the text attachment limit. */
export function classifyPastedText(text: string, byteLength: number): InputResourceResult<InputResourceClassification> {
    if (byteLength > MAX_ATTACHED_TEXT_FILE_BYTES) {
        return resourceFailed("semantic_input_resource_too_large", "pasted text exceeds the text attachment limit")
    }
    return resourceSucceeded({ kind: "pasted_text", mediaType: PLAIN_TEXT_MEDIA_TYPE, lineCount: countTextLines(text) })
}

/**
 * An inline image, a refusal for one beyond the inline dimension, or nothing
 * when the bytes are not an inline image format at all.
 */
function classifyImage(displayName: string, bytes: Uint8Array): InputResourceResult<InputResourceClassification> | undefined {
    const detected = detectImage(bytes)
    const mediaType = detected?.type ? IMAGE_MEDIA_TYPE_BY_DETECTED_FORMAT[detected.type] : undefined
    if (!detected || !mediaType) return undefined
    if ((detected.width ?? 0) > MAX_INPUT_IMAGE_DIMENSION_PX || (detected.height ?? 0) > MAX_INPUT_IMAGE_DIMENSION_PX) {
        return resourceFailed(
            "semantic_input_resource_too_large",
            `${displayName} exceeds ${MAX_INPUT_IMAGE_DIMENSION_PX}px in width or height`,
        )
    }
    return resourceSucceeded({ kind: "image", mediaType })
}

function detectImage(bytes: Uint8Array): ReturnType<typeof sizeOf> | undefined {
    try {
        return sizeOf(bytes)
    } catch {
        // Unrecognized or truncated image data.
        return undefined
    }
}

/** A binary document whose bytes start with the container its extension names. */
function recognizeDocument(displayName: string, bytes: Uint8Array): InputResourceClassification | undefined {
    const document = DOCUMENT_FORMAT_BY_EXTENSION[attachmentExtension(displayName)]
    return document && startsWith(bytes, document.signature) ? { kind: "file", mediaType: document.mediaType } : undefined
}

async function recognizeText(displayName: string, bytes: Uint8Array): Promise<InputResourceClassification | undefined> {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (await isBinaryFile(buffer, buffer.byteLength)) return undefined
    const mediaType = TEXT_MEDIA_TYPE_BY_EXTENSION[attachmentExtension(displayName)] ?? PLAIN_TEXT_MEDIA_TYPE
    return { kind: "file", mediaType, lineCount: countTextLines(buffer.toString("utf8")) }
}

/** Only a verified PDF is kept whole for native input; everything else recognized is read into text. */
function withinFormatLimit(
    displayName: string,
    bytes: Uint8Array,
    recognized: InputResourceClassification,
): InputResourceResult<InputResourceClassification> {
    const limit = recognized.mediaType === PDF_MEDIA_TYPE ? MAX_ATTACHED_PDF_BYTES : MAX_ATTACHED_TEXT_FILE_BYTES
    if (bytes.byteLength <= limit) return resourceSucceeded(recognized)
    return resourceFailed(
        "semantic_input_resource_too_large",
        `${displayName} exceeds the ${formatBytes(limit)} limit for ${recognized.mediaType} content`,
    )
}

function classifyOpaqueBinary(displayName: string, bytes: Uint8Array): InputResourceResult<InputResourceClassification> {
    if (!fitsBase64TextLimit(bytes.byteLength)) {
        return resourceFailed(
            "semantic_input_resource_too_large",
            `${displayName} is binary content sent as base64 text, which would exceed the ${formatBytes(MAX_ATTACHED_BASE64_TEXT_BYTES)} per-attachment text budget`,
        )
    }
    return resourceSucceeded({ kind: "file", mediaType: OPAQUE_BINARY_MEDIA_TYPE })
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
    return bytes.byteLength >= signature.byteLength && signature.every((byte, index) => bytes[index] === byte)
}
