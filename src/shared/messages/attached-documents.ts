import type {
	ClineContent,
	ClineDocumentContentBlock,
	ClineStorageMessage,
	ClineTextContentBlock,
	ClineUserAttachedDocumentBlock,
} from "./content"

/** Native PDF capacity of one request, as documented by the target provider API. */
export interface DocumentInputLimits {
	/** Combined decoded size, in bytes, of every PDF one request may carry natively. */
	maxTotalBytes: number
	/** Combined page count of every PDF one request may carry natively, when the API limits pages. */
	maxTotalPages?: number
}

export function isAttachedDocumentBlock(block: ClineContent): block is ClineUserAttachedDocumentBlock {
	return block.type === "attached_document"
}

/**
 * Choose which attached PDFs one request carries natively.
 *
 * Provider limits apply to the whole request, and history is resent on every turn, so the budget is shared
 * by every attachment still in context. Newest attachments are admitted first because the current turn is
 * most likely about them; older ones fall back to their extracted text once the budget is spent. An
 * attachment whose page count is unknown is never admitted against a page limit, since a rejected PDF
 * would fail every later request of the task.
 */
export function selectNativeDocuments(
	messages: readonly ClineStorageMessage[],
	limits: DocumentInputLimits | undefined,
): ReadonlySet<ClineUserAttachedDocumentBlock> {
	const admitted = new Set<ClineUserAttachedDocumentBlock>()
	if (!limits) return admitted

	let remainingBytes = limits.maxTotalBytes
	let remainingPages = limits.maxTotalPages
	for (const block of attachedDocumentsNewestFirst(messages)) {
		if (block.byte_length > remainingBytes) continue
		if (remainingPages !== undefined) {
			if (block.page_count === undefined || block.page_count > remainingPages) continue
			remainingPages -= block.page_count
		}
		remainingBytes -= block.byte_length
		admitted.add(block)
	}
	return admitted
}

/**
 * Project one attached PDF into blocks every converter understands.
 *
 * A native projection keeps the path visible to the model in a text block and sends the bytes as an
 * Anthropic-shaped `document` block; protocol converters translate that block into their own file part.
 */
export function projectAttachedDocument(
	block: ClineUserAttachedDocumentBlock,
	native: boolean,
	limits: DocumentInputLimits | undefined,
): Array<ClineTextContentBlock | ClineDocumentContentBlock> {
	if (!native) {
		return [{ type: "text", text: limits ? `${OVER_BUDGET_NOTICE}\n${block.fallback_text}` : block.fallback_text }]
	}
	return [
		{
			type: "text",
			text: `<file_content path="${block.path}">\n(Attached in full as the PDF document that follows.)\n</file_content>`,
		},
		{
			type: "document",
			source: { type: "base64", media_type: block.media_type, data: block.data },
			title: documentFileName(block.path),
			...(block.page_count === undefined ? {} : { page_count: block.page_count }),
		},
	]
}

/** File name a provider shows for a native PDF, taken from the attachment's POSIX path. */
export function documentFileName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1) || path
}

const OVER_BUDGET_NOTICE =
	"(This PDF exceeds the native document limit of the current request, so only its extracted text is included.)"

function* attachedDocumentsNewestFirst(messages: readonly ClineStorageMessage[]): Generator<ClineUserAttachedDocumentBlock> {
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const content = messages[messageIndex].content
		if (!Array.isArray(content)) continue
		for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
			const block = content[blockIndex]
			if (isAttachedDocumentBlock(block)) yield block
		}
	}
}
