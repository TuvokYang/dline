/**
 * Attachment rules shared by the Webview composer and the extension host.
 *
 * The composer uses them to decide what a drop or paste can attach before any bytes leave the
 * Webview; the host re-validates with the same rules before it reads or stages a file.
 */

import { MAX_CONTENT_SIZE_BYTES } from "./content-limits"

/** Image types every image-capable provider accepts as inline image input. */
export const ATTACHABLE_IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp"]

/**
 * Document types the "Add files" picker offers. Drops and pastes are not limited to this list: any
 * non-image file attaches. Text is read as text, binary documents are read by their format, and any
 * other binary content is sent as base64 text within {@link fitsBase64TextLimit}.
 */
export const ATTACHABLE_FILE_EXTENSIONS: readonly string[] = [
    "xml",
    "json",
    "txt",
    "log",
    "md",
    "docx",
    "ipynb",
    "pdf",
    "xlsx",
    "csv",
]

/** PDFs are kept whole for native document input, so they follow the largest provider PDF limit. */
export const MAX_ATTACHED_PDF_BYTES = 50 * 1000 * 1000

/** Other non-image attachments are read into text, so they share the text input limit. */
export const MAX_ATTACHED_TEXT_FILE_BYTES = 20 * 1000 * 1024

/**
 * Largest base64 text one attachment of content no reader understands may contribute.
 *
 * Extracted text is truncated to the per-attachment content budget before it reaches the model;
 * base64 cannot be truncated without becoming meaningless, so the whole encoding must fit that
 * same budget or the attachment is refused when the input is prepared.
 */
export const MAX_ATTACHED_BASE64_TEXT_BYTES = MAX_CONTENT_SIZE_BYTES

/** Length of the base64 text that encodes `byteLength` bytes. */
export function base64EncodedLength(byteLength: number): number {
    return 4 * Math.ceil(byteLength / 3)
}

/** Whether binary content no reader understands may be attached, sent whole as base64 text. */
export function fitsBase64TextLimit(byteLength: number): boolean {
    return base64EncodedLength(byteLength) <= MAX_ATTACHED_BASE64_TEXT_BYTES
}

/** Lower-case extension without the leading dot, or an empty string when the name has none. */
export function attachmentExtension(fileName: string): string {
    const baseName = fileName.split(/[\\/]/).pop() ?? ""
    const dot = baseName.lastIndexOf(".")
    return dot > 0 ? baseName.slice(dot + 1).toLowerCase() : ""
}

export function isAttachableImageName(fileName: string): boolean {
    return ATTACHABLE_IMAGE_EXTENSIONS.includes(attachmentExtension(fileName))
}

export function isPdfFileName(fileName: string): boolean {
    return attachmentExtension(fileName) === "pdf"
}

/**
 * Binary documents an @-mention cannot read (it only reads text files), so the composer attaches them
 * instead: PDFs travel as native documents, Word and Excel files as extracted text.
 */
const BINARY_DOCUMENT_EXTENSIONS: readonly string[] = ["pdf", "docx", "xlsx"]

export function isBinaryDocumentName(fileName: string): boolean {
    return BINARY_DOCUMENT_EXTENSIONS.includes(attachmentExtension(fileName))
}

/** Largest accepted size for a non-image attachment with this name. */
export function maxAttachmentBytes(fileName: string): number {
    return isPdfFileName(fileName) ? MAX_ATTACHED_PDF_BYTES : MAX_ATTACHED_TEXT_FILE_BYTES
}

/** Human-readable size limit used in rejection messages, e.g. "50MB". */
export function formatAttachmentLimit(fileName: string): string {
    return `${Math.round(maxAttachmentBytes(fileName) / (1000 * 1000))}MB`
}
