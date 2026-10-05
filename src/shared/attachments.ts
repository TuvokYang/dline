/**
 * Attachment rules shared by the Webview composer and the extension host.
 *
 * The composer uses them to decide what a drop or paste can attach before any bytes leave the
 * Webview; the host re-validates with the same rules before it reads or stages a file.
 */

/** Image types every image-capable provider accepts as inline image input. */
export const ATTACHABLE_IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp"]

/**
 * Document types the "Add files" picker offers. Drops and pastes are not limited to this list: any
 * non-image file attaches, and everything except binary documents is read as text.
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

/**
 * Whether an attached file is read as plain text: every non-image file except binary documents,
 * whatever its extension. The host rejects such a file when its content turns out not to be text.
 */
export function isTextAttachmentName(fileName: string): boolean {
	return !isBinaryDocumentName(fileName)
}

/** Largest accepted size for a non-image attachment with this name. */
export function maxAttachmentBytes(fileName: string): number {
	return isPdfFileName(fileName) ? MAX_ATTACHED_PDF_BYTES : MAX_ATTACHED_TEXT_FILE_BYTES
}

/** Human-readable size limit used in rejection messages, e.g. "50MB". */
export function formatAttachmentLimit(fileName: string): string {
	return `${Math.round(maxAttachmentBytes(fileName) / (1000 * 1000))}MB`
}
