import type { ChatContent } from "@shared/ChatContent"
import type { SemanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import { ChatContent as WireChatContent } from "@shared/proto/dline/state"
import { decodeAdmissibleSemanticInputDocument, toProtoSemanticInputDocument } from "./document"

export type ChatContentDecodeResult =
    | { readonly ok: true; readonly content: ChatContent | undefined }
    | { readonly ok: false; readonly diagnostic: SemanticInputDiagnostic }

export function toProtoChatContent(content: ChatContent): WireChatContent {
    return WireChatContent.create({
        message: content.message,
        images: content.images ?? [],
        files: content.files ?? [],
        semanticInput: content.semanticInput ? toProtoSemanticInputDocument(content.semanticInput) : undefined,
    })
}

/**
 * Decode the draft a transition request carries.
 *
 * A semantic draft that cannot be decoded, or decodes into an invalid document,
 * fails the request rather than falling back to the flat mirror: the mirror
 * cannot tell a command the user confirmed from one that only looks like it, so
 * using it would change the draft's meaning.
 */
export function fromProtoChatContent(wire: WireChatContent | undefined): ChatContentDecodeResult {
    if (!wire) return { ok: true, content: undefined }
    const content: ChatContent = {
        ...(wire.message === undefined ? {} : { message: wire.message }),
        ...(wire.images.length > 0 ? { images: [...wire.images] } : {}),
        ...(wire.files.length > 0 ? { files: [...wire.files] } : {}),
    }
    if (!wire.semanticInput) return { ok: true, content }
    const decoded = decodeAdmissibleSemanticInputDocument(wire.semanticInput)
    if (!decoded.ok) return decoded
    return { ok: true, content: { ...content, semanticInput: decoded.document } }
}
