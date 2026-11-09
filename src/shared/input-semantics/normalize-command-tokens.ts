import { commandTriggersOf, findDescriptor, type InputSemanticCatalog } from "./catalog"
import { type SemanticInputDocument, type SemanticInputNode } from "./document"
import { presentationTextOf } from "./presentation"

/**
 * Canonicalize only tokens already recognized and bound by the preprocessor.
 * Run after composer coordinate projection: changing a token's UTF-16 length
 * earlier would shift the spans of mentions, pasted content and resource atoms.
 * This never parses raw text or activates held candidates.
 */
export function normalizeCommandTokens(document: SemanticInputDocument, catalog: InputSemanticCatalog): SemanticInputDocument {
    let changed = false
    const nodes = document.nodes.map((node): SemanticInputNode => {
        if (node.kind !== "slash_command" || node.state !== "recognized") return node
        const descriptor = findDescriptor(catalog, node.commandId)
        if (descriptor?.inputPolicy !== "consume_token_keep_content") return node
        const triggers = commandTriggersOf(descriptor)
        const sourceText = triggers.find((trigger) => trigger.startsWith("/cmd:")) ?? descriptor.trigger
        if (sourceText === node.sourceText) return node
        changed = true
        return { ...node, sourceText }
    })
    if (!changed) return document
    const normalized = { ...document, nodes }
    return { ...normalized, rawText: presentationTextOf(normalized) }
}
