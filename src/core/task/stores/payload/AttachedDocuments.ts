import type { ClineUserAttachedDocumentBlock } from "@shared/messages/content"
import type { TaskPayloadStore } from "../contracts"
import { decodeTaskPayload, encodeTaskPayload } from "./TaskPayloadCodec"
import type { AttachedDocumentEnvelope } from "./TaskPayloadEnvelopes"

/**
 * Store the PDFs that travel beside a tool result, one payload each.
 *
 * Payloads are content addressed, so a terminal manifest that replaces the raw
 * result, or a replay after a restart, references the same bytes instead of
 * re-encoding them, and an identical attachment is stored once.
 * @returns Refs in attachment order; `undefined` when there is nothing to store.
 */
export async function putAttachedDocuments(
	payloads: Pick<TaskPayloadStore, "put">,
	documents: readonly ClineUserAttachedDocumentBlock[] | undefined,
): Promise<readonly string[] | undefined> {
	if (!documents?.length) return undefined
	const refs: string[] = []
	for (const document of documents) {
		const envelope: AttachedDocumentEnvelope = { kind: "attached_document", document }
		refs.push(await payloads.put(encodeTaskPayload(envelope)))
	}
	return refs
}

/**
 * Read the documents a tool result references, in attachment order.
 * @throws `InvalidAttachedDocumentPayload` when a ref names another payload kind.
 */
export async function readAttachedDocuments(
	payloads: Pick<TaskPayloadStore, "read">,
	refs: readonly string[] | undefined,
): Promise<ClineUserAttachedDocumentBlock[]> {
	if (!refs?.length) return []
	const documents: ClineUserAttachedDocumentBlock[] = []
	for (const ref of refs) {
		const envelope = decodeTaskPayload<AttachedDocumentEnvelope>(await payloads.read(ref))
		if (envelope.kind !== "attached_document") throw new Error("InvalidAttachedDocumentPayload")
		documents.push(envelope.document)
	}
	return documents
}
