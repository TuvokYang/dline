import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { ChatContent } from "@shared/proto/dline/state"
import { toProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { hasTransitionDraftContent } from "@shared/TransitionDraft"

/** The composer draft a Mode or Profile switch carries to the task. */
export interface TransitionDraftContent {
    readonly text: string
    readonly images: readonly string[]
    readonly files: readonly string[]
    /**
     * The structure the composer held when the switch started.
     *
     * Carried with the text so the reply the switch delivers keeps the node
     * order, inert pasted text and resource placement the user composed,
     * instead of a re-parse of the captured string.
     */
    readonly semanticInput?: SemanticInputDocument
}

/**
 * The composer a switch took its draft from.
 *
 * A switch settles long after it captured the draft; by then the user may
 * have edited the composer or sent something else from it. Letting the draft
 * go, or sending it on, is the switch's to do only while the composer still
 * holds exactly the draft it captured; anything else is the user's newer work.
 */
export interface TransitionDraftComposer<TDraft extends TransitionDraftContent = TransitionDraftContent> {
    /** Whether the composer still holds `captured`, unedited and unsent. */
    holds(captured: TDraft): boolean
    /** Empty the composer of the draft its switch delivered. */
    retire(): void
}

/** The draft as a switch request carries it; nothing when the draft is empty. */
export function transitionChatContentOf(draft: TransitionDraftContent): ChatContent | undefined {
    if (!hasTransitionDraftContent(draft)) return undefined
    return {
        message: draft.text || undefined,
        images: [...draft.images],
        files: [...draft.files],
        ...(draft.semanticInput ? { semanticInput: toProtoSemanticInputDocument(draft.semanticInput) } : {}),
    }
}
