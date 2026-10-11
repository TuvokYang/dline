import {
    attachmentExtension,
    formatAttachmentLimit,
    isAttachableImageName,
    MAX_ATTACHED_TEXT_FILE_BYTES,
    maxAttachmentBytes,
} from "@shared/attachments"
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

const PASTED_TEXT_MEDIA_TYPE = "text/plain"

/** Attachable image formats keyed by the format `image-size` detects from the bytes. */
const IMAGE_MEDIA_TYPE_BY_DETECTED_FORMAT: Readonly<Record<string, string>> = {
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp",
}

const ZIP_SIGNATURE = Uint8Array.from([0x50, 0x4b, 0x03, 0x04])

/** Binary documents are accepted only when their bytes start with their container signature. */
const DOCUMENT_FORMAT_BY_EXTENSION: Readonly<Record<string, { readonly mediaType: string; readonly signature: Uint8Array }>> = {
    pdf: { mediaType: "application/pdf", signature: new TextEncoder().encode("%PDF-") },
    docx: { mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", signature: ZIP_SIGNATURE },
    xlsx: { mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", signature: ZIP_SIGNATURE },
}

/** Text formats with a specific media type; every other text file is plain text. */
const TEXT_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
    md: "text/markdown",
    markdown: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    ipynb: "application/x-ipynb+json",
}

/**
 * Decide what one named file's bytes are, or why they cannot be attached.
 *
 * This is the only place a media type is assigned to input content. The name
 * selects which format to expect; the bytes must then prove it, so a renamed
 * file cannot smuggle an unsupported or unexpected payload to a provider. An
 * image's media type comes from its detected format rather than its extension,
 * because providers decode by the declared type.
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
    if (isAttachableImageName(displayName)) return classifyImage(displayName, bytes)

    const document = DOCUMENT_FORMAT_BY_EXTENSION[attachmentExtension(displayName)]
    if (document) {
        return startsWith(bytes, document.signature)
            ? resourceSucceeded({ kind: "file", mediaType: document.mediaType })
            : resourceFailed("semantic_input_resource_invalid_mime", `${displayName} is not a valid ${document.mediaType} file`)
    }
    return classifyTextFile(displayName, bytes)
}

/** Classify text the user pasted; its size is checked against the text attachment limit. */
export function classifyPastedText(text: string, byteLength: number): InputResourceResult<InputResourceClassification> {
    if (byteLength > MAX_ATTACHED_TEXT_FILE_BYTES) {
        return resourceFailed("semantic_input_resource_too_large", "pasted text exceeds the text attachment limit")
    }
    return resourceSucceeded({ kind: "pasted_text", mediaType: PASTED_TEXT_MEDIA_TYPE, lineCount: countTextLines(text) })
}

function classifyImage(displayName: string, bytes: Uint8Array): InputResourceResult<InputResourceClassification> {
    const detected = detectImage(bytes)
    const mediaType = detected?.type ? IMAGE_MEDIA_TYPE_BY_DETECTED_FORMAT[detected.type] : undefined
    if (!detected || !mediaType) {
        return resourceFailed("semantic_input_resource_invalid_mime", `${displayName} is not a PNG, JPEG or WebP image`)
    }
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

async function classifyTextFile(
    displayName: string,
    bytes: Uint8Array,
): Promise<InputResourceResult<InputResourceClassification>> {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (await isBinaryFile(buffer, buffer.byteLength)) {
        return resourceFailed(
            "semantic_input_resource_invalid_mime",
            `${displayName} is not a text file; attach images, PDF, Word, Excel or text files`,
        )
    }
    const mediaType = TEXT_MEDIA_TYPE_BY_EXTENSION[attachmentExtension(displayName)] ?? PASTED_TEXT_MEDIA_TYPE
    return resourceSucceeded({ kind: "file", mediaType, lineCount: countTextLines(buffer.toString("utf8")) })
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
    return bytes.byteLength >= signature.byteLength && signature.every((byte, index) => bytes[index] === byte)
}
