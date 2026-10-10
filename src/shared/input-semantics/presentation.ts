import type { SemanticInputDocument, SemanticInputNode } from "./document"

/**
 * Stable text projection of one node.
 *
 * A resource is addressed by its stable resource id rather than its display
 * name, so renaming a display label never changes the projection that Core
 * compares against `rawText`.
 */
export function presentationTextOfNode(node: SemanticInputNode): string {
    switch (node.kind) {
        case "text":
            return node.text
        case "slash_command":
        case "mention":
            return node.sourceText
        case "image":
            return `[image:${node.resourceId}]`
        case "file":
            return `[file:${node.resourceId}]`
    }
}

/** Stable text projection of the whole document, in node order. */
export function presentationTextOf(document: SemanticInputDocument): string {
    return document.nodes.map(presentationTextOfNode).join("")
}

/**
 * Whether `rawText` still matches the ordered nodes.
 *
 * A mismatch means the two views of the same draft disagree. Core may report it,
 * but it must never resolve the disagreement by re-reading `rawText`.
 */
export function documentMatchesPresentation(document: SemanticInputDocument): boolean {
    return document.rawText === presentationTextOf(document)
}
