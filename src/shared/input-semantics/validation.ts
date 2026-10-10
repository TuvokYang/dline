import { type SemanticInputDiagnostic, type SemanticInputDiagnosticCode, semanticInputDiagnostic } from "./diagnostics"
import {
    INPUT_SOURCES,
    type InputResourceOwner,
    isActiveEntity,
    isIdentifiedNode,
    isLiteralNode,
    isMentionNode,
    isResourceNode,
    isSlashCommandNode,
    SEMANTIC_INPUT_SCHEMA_VERSION,
    type SemanticInputDocument,
    type SemanticInputNode,
    type SemanticResourceRef,
} from "./document"

/*
 * Structural validation only: catalog membership, capability, access and the
 * resource store's own record belong to Core admission. This module judges
 * whether the document describes itself consistently.
 */

function nodeIdentityProblem(node: SemanticInputNode): string | undefined {
    if (isLiteralNode(node)) {
        return INPUT_SOURCES.includes(node.source) ? undefined : "literal node carries an unknown source"
    }
    if (!isIdentifiedNode(node)) return undefined
    if (!node.entityId) return "node is missing a stable entity id"
    if (isSlashCommandNode(node)) {
        if (!node.canonicalName) return "slash command node is missing a canonical name"
        // A command shape the catalog does not know stays inert content: it carries
        // no catalog identity, and only an active entity must resolve to one.
        if (isActiveEntity(node) && !node.commandId) {
            return "active slash command node is missing a catalog command id"
        }
        return undefined
    }
    if (isMentionNode(node)) {
        return node.canonicalRef ? undefined : "mention node is missing a canonical reference"
    }
    return node.resourceId ? undefined : "resource node is missing a resource id"
}

function ownerProblem(owner: InputResourceOwner | undefined): string | undefined {
    if (!owner) return "resource reference has no owner"
    if (owner.kind === "draft") return owner.draftId ? undefined : "draft owner is missing its draft id"
    if (owner.kind === "task") return owner.taskId ? undefined : "task owner is missing its task id"
    return "resource reference names an unknown owner kind"
}

/** Problems with the metadata a reference claims, independent of any node. */
function referenceProblems(resource: SemanticResourceRef): readonly string[] {
    const problems: string[] = []
    if (!resource.expectedContentHash) problems.push("resource reference is missing the frozen content hash")
    if (!resource.mediaType) problems.push("resource reference is missing its media type")
    if (!Number.isSafeInteger(resource.byteLength) || resource.byteLength < 0) {
        problems.push("resource reference carries an invalid byte length")
    }
    if (!Number.isSafeInteger(resource.generation) || resource.generation < 1) {
        problems.push("resource reference carries an invalid generation")
    }
    const owner = ownerProblem(resource.owner)
    if (owner) problems.push(owner)
    return problems
}

/**
 * Validate one document's internal consistency.
 *
 * Every diagnostic points at the document and, when the problem is local, at the
 * entity or resource, so a composer can highlight the exact node instead of
 * reporting that parsing failed.
 */
export function validateSemanticInputDocument(document: SemanticInputDocument): readonly SemanticInputDiagnostic[] {
    const diagnostics: SemanticInputDiagnostic[] = []
    const documentId = document.documentId
    const report = (code: SemanticInputDiagnosticCode, message: string, ids?: { entityId?: string; resourceId?: string }) =>
        diagnostics.push(semanticInputDiagnostic(code, message, { documentId, ...ids }))

    if (document.schemaVersion !== SEMANTIC_INPUT_SCHEMA_VERSION) {
        report("semantic_input_schema_unsupported", `unsupported semantic input schema version ${document.schemaVersion}`)
    }
    if (!documentId) {
        report("semantic_input_schema_unsupported", "document is missing a stable document id")
    }
    if (!document.parserVersion) {
        report("semantic_input_parser_unsupported", "document is missing a parser version")
    }
    if (!document.catalogRevision) {
        report("semantic_input_catalog_stale", "document is missing the catalog revision it was composed against")
    }

    const seenEntityIds = new Set<string>()
    const referencedResourceIds = new Set<string>()
    const imageResourceIds = new Set<string>()
    let barriers = 0

    for (const node of document.nodes) {
        const problem = nodeIdentityProblem(node)
        if (problem) {
            report("semantic_input_node_invalid", problem, { entityId: isIdentifiedNode(node) ? node.entityId : undefined })
            continue
        }
        if (!isIdentifiedNode(node)) continue

        if (seenEntityIds.has(node.entityId)) {
            report("semantic_input_node_invalid", "entity id is used by more than one node", { entityId: node.entityId })
        }
        seenEntityIds.add(node.entityId)

        if (isResourceNode(node)) referencedResourceIds.add(node.resourceId)
        if (node.kind === "image") imageResourceIds.add(node.resourceId)
        if (isSlashCommandNode(node) && isActiveEntity(node) && node.compositionMode === "lifecycle_barrier") barriers += 1
    }

    if (barriers > 1) {
        report("semantic_input_lifecycle_barrier_invalid", "document declares more than one lifecycle barrier")
    }

    const boundResourceIds = new Set<string>()
    for (const binding of document.resources) {
        if (!binding.resourceId) {
            report("semantic_input_resource_invalid", "resource binding is missing a resource id")
            continue
        }
        for (const problem of referenceProblems(binding)) {
            report("semantic_input_resource_invalid", problem, { resourceId: binding.resourceId })
        }
        if (imageResourceIds.has(binding.resourceId) && binding.mediaType && !binding.mediaType.startsWith("image/")) {
            report("semantic_input_resource_invalid_mime", "image node is bound to content that is not an image", {
                resourceId: binding.resourceId,
            })
        }
        if (boundResourceIds.has(binding.resourceId)) {
            report("semantic_input_resource_invalid", "resource is bound more than once", {
                resourceId: binding.resourceId,
            })
        }
        boundResourceIds.add(binding.resourceId)

        if (!referencedResourceIds.has(binding.resourceId)) {
            report("semantic_input_resource_invalid", "resource binding has no node referencing it", {
                resourceId: binding.resourceId,
            })
        }
    }

    for (const resourceId of referencedResourceIds) {
        if (!boundResourceIds.has(resourceId)) {
            report("semantic_input_resource_missing", "resource node has no binding with a frozen content hash", {
                resourceId,
            })
        }
    }

    return diagnostics
}
