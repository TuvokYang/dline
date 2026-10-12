import { isContentNode, type SemanticInputDocument } from "./input-semantics/document"

/** The parts of a transition draft that decide whether it holds anything. */
export interface TransitionDraftParts {
    readonly text?: string
    readonly images?: readonly string[]
    readonly files?: readonly string[]
    readonly semanticInput?: SemanticInputDocument
}

/**
 * Whether a transition draft holds anything the user authored, including a
 * resource with no text around it.
 *
 * The Webview decides with it whether a switch carries a draft and the task
 * whether there is one to keep or deliver; one answer keeps both sides from
 * disagreeing about a draft that is only whitespace or only a resource.
 */
export function hasTransitionDraftContent(draft: TransitionDraftParts | undefined): boolean {
    return Boolean(
        draft?.text?.trim() ||
            draft?.images?.length ||
            draft?.files?.length ||
            draft?.semanticInput?.nodes.some((node) => !isContentNode(node) || node.text.trim()),
    )
}

/**
 * A draft a Mode or Profile switch carried to a dialog that still awaits a reply.
 *
 * The task keeps it until that dialog takes it, so a composer that was lost
 * with the window while the switch ran can be given the draft back.
 */
export interface TransitionDraftProjection {
    readonly taskId: string
    /** Changes whenever another draft is recorded, so a restore happens once per draft. */
    readonly draftId: string
    readonly text: string
    readonly images: readonly string[]
    readonly files: readonly string[]
    readonly semanticInput?: SemanticInputDocument
}
