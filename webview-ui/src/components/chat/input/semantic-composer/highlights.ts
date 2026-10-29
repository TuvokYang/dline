import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { MentionInputNode, SlashCommandInputNode } from "@shared/input-semantics/document"
import type { ComposerDecoration } from "./dom"
import type { ComposerProjection } from "./projection"

/** A typed command or mention the catalog recognizes; it runs when sent. */
export const TYPED_ENTITY_CLASS = "mention-context-textarea-highlight"
/** A pasted or restored candidate the catalog knows; it is sent as text until the user picks it. */
export const HELD_CANDIDATE_CLASS = "composer-held-candidate"

export interface ComposerHighlights {
    readonly decorations: readonly ComposerDecoration[]
    /** The source text of every held candidate, in draft order, for the notice that explains them. */
    readonly heldCandidates: readonly string[]
}

const NO_HIGHLIGHTS: ComposerHighlights = { decorations: [], heldCandidates: [] }

/** Whether the catalog could run this entity, had the user typed or picked it. */
function isResolvable(node: SlashCommandInputNode | MentionInputNode, catalog: InputSemanticCatalog): boolean {
    if (node.kind === "slash_command") return node.commandId !== ""
    return catalog.descriptors.some((descriptor) => descriptor.id === `mention.${node.mentionKind}`)
}

/**
 * How the draft's text entities look, read from the same projection a send uses.
 *
 * Atoms draw themselves as chips, so only lexed text is decorated. A typed
 * entity is recognized exactly when it will run. A candidate that stays
 * unresolved although the catalog knows it can only be held text the user did
 * not type, so it is marked and explained rather than shown as active.
 */
export function composerHighlights(
    projection: ComposerProjection | undefined,
    catalog: InputSemanticCatalog,
): ComposerHighlights {
    if (!projection) return NO_HIGHLIGHTS
    const decorations: ComposerDecoration[] = []
    const heldCandidates: string[] = []
    for (const { range, node, isAtom } of projection.entities) {
        if (isAtom) continue
        if (node.state === "recognized") {
            decorations.push({ range, className: TYPED_ENTITY_CLASS })
        } else if (isResolvable(node, catalog)) {
            decorations.push({ range, className: HELD_CANDIDATE_CLASS })
            heldCandidates.push(node.sourceText)
        }
    }
    return { decorations, heldCandidates }
}
