import { isAttachableImageName, isBinaryDocumentName, maxAttachmentBytes } from "@shared/attachments"

/**
 * Classifies what a drop or paste delivers to the chat composer.
 *
 * Sources differ by platform: VS Code Explorer drags carry resource URIs, OS file-manager drags and
 * clipboard file pastes carry File objects without any host path, and some Linux file managers also
 * put `file://` URIs into the plain-text payload.
 */

/** Image MIME types every image-capable provider accepts (jpg is reported as image/jpeg). */
const INLINE_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"]

const RESOURCE_URI_SCHEMES: readonly string[] = ["vscode-file:", "file:", "vscode-remote:"]

type TransferData = Pick<DataTransfer, "getData">

/** URIs carried by a VS Code Explorer (or editor tab) drag. */
export function readResourceUris(transfer: TransferData): string[] {
	let uris: string[] = []
	const resourceUrls = transfer.getData("resourceurls")
	if (resourceUrls) {
		try {
			uris = (JSON.parse(resourceUrls) as string[]).map((uri) => decodeURIComponent(uri))
		} catch (error) {
			console.error("Failed to parse resourceurls JSON:", error)
		}
	}
	if (uris.length === 0) {
		uris = transfer
			.getData("application/vnd.code.uri-list")
			.split("\n")
			.map((uri) => uri.trim())
	}
	return uris.filter((uri) => uri && RESOURCE_URI_SCHEMES.some((scheme) => uri.startsWith(scheme)))
}

/** Last path segment of a URI, decoded, used only to classify the file by extension. */
function uriFileName(uri: string): string {
	const withoutQuery = uri.split(/[?#]/)[0]
	const segment = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1)
	try {
		return decodeURIComponent(segment)
	} catch {
		return segment
	}
}

/** Explorer-dropped files that an @-mention cannot read, so they are attached instead. */
export function isDocumentAttachmentUri(uri: string): boolean {
	return isBinaryDocumentName(uriFileName(uri))
}

/**
 * The `file://` URIs in a plain-text payload when the payload is nothing but non-image file URIs
 * (Linux file managers copy or drag files this way). Any other text yields an empty list so it is
 * still inserted as text.
 */
export function parseAttachableFileUris(text: string): string[] {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
	if (lines.length === 0) {
		return []
	}
	const allAttachable = lines.every((line) => line.startsWith("file://") && !isAttachableImageName(uriFileName(line)))
	return allAttachable ? lines : []
}

export interface TransferFileClassification {
	/** Inline images, read into data URLs by the Webview. */
	readonly images: File[]
	/**
	 * Every other file within its size limit, sent to the extension host to be staged as an attachment.
	 * Files other than PDF, Word and Excel are read as text; the host rejects content that is not text.
	 */
	readonly attachments: File[]
	/** Files above their attachment size limit (PDF 50MB, everything else the text input limit). */
	readonly rejected: File[]
}

/** Splits dropped or pasted files into inline images, attachable files, and oversized files. */
export function classifyTransferFiles(files: readonly File[]): TransferFileClassification {
	const images: File[] = []
	const attachments: File[] = []
	const rejected: File[] = []
	for (const file of files) {
		if (INLINE_IMAGE_TYPES.includes(file.type) || (!file.type && isAttachableImageName(file.name))) {
			images.push(file)
		} else if (file.size <= maxAttachmentBytes(file.name)) {
			attachments.push(file)
		} else {
			rejected.push(file)
		}
	}
	return { images, attachments, rejected }
}
