import { isResourceNode, type SemanticInputDocument, type SemanticInputNode } from "./document"
import { presentationTextOf } from "./presentation"

/**
 * The part of a document the user placed before one of its entities.
 *
 * Used when a lifecycle command is taken out of a submission: what remains is
 * still the structure the user confirmed, so a later stage reads the same typed
 * commands, mentions and resources instead of re-deriving them from text, and
 * the command itself is no longer there to act a second time. Edge whitespace
 * is trimmed like the kept text, and only the resources the remaining nodes
 * reference stay attached.
 *
 * Returns undefined when the document has no entity with that identity.
 */
export function documentBeforeEntity(document: SemanticInputDocument, entityId: string): SemanticInputDocument | undefined {
    const index = document.nodes.findIndex((node) => "entityId" in node && node.entityId === entityId)
    if (index === -1) return undefined
    const nodes = trimEdgeText(document.nodes.slice(0, index))
    const referenced = new Set(nodes.filter(isResourceNode).map((node) => node.resourceId))
    const prefix: SemanticInputDocument = {
        ...document,
        nodes,
        resources: document.resources.filter((resource) => referenced.has(resource.resourceId)),
    }
    return { ...prefix, rawText: presentationTextOf(prefix) }
}

function trimEdgeText(nodes: readonly SemanticInputNode[]): SemanticInputNode[] {
    const trimmed = [...nodes]
    const first = trimmed[0]
    if (first?.kind === "text") trimmed[0] = { ...first, text: first.text.trimStart() }
    const lastIndex = trimmed.length - 1
    const last = trimmed[lastIndex]
    if (last?.kind === "text") trimmed[lastIndex] = { ...last, text: last.text.trimEnd() }
    return trimmed.filter((node) => node.kind !== "text" || node.text.length > 0)
}
