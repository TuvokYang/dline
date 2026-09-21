import {
	isActiveEntity,
	isIdentifiedNode,
	isMentionNode,
	isResourceNode,
	isSlashCommandNode,
	SEMANTIC_INPUT_SCHEMA_VERSION,
	type SemanticInputDocument,
	type SemanticInputNode,
} from "./document"

/**
 * Stable diagnostic codes for structural input problems.
 *
 * Catalog membership, capability and access checks belong to Core admission;
 * this module only judges whether the document describes itself consistently.
 */
export type SemanticInputDiagnosticCode =
	| "semantic_input_schema_unsupported"
	| "semantic_input_parser_unsupported"
	| "semantic_input_catalog_stale"
	| "semantic_input_node_invalid"
	| "semantic_input_command_unknown"
	| "semantic_input_command_disabled"
	| "semantic_input_resource_missing"
	| "semantic_input_resource_invalid"
	| "semantic_input_lifecycle_barrier_invalid"

export interface SemanticInputDiagnostic {
	readonly code: SemanticInputDiagnosticCode
	/** English, actionable, and free of file contents or credentials. */
	readonly message: string
	readonly documentId: string
	readonly entityId?: string
	readonly resourceId?: string
}

function nodeIdentityProblem(node: SemanticInputNode): string | undefined {
	if (!isIdentifiedNode(node)) return undefined
	if (!node.entityId) return "node is missing a stable entity id"
	if (isSlashCommandNode(node)) {
		if (!node.commandId) return "slash command node is missing a catalog command id"
		if (!node.canonicalName) return "slash command node is missing a canonical name"
		return undefined
	}
	if (isMentionNode(node)) {
		return node.canonicalRef ? undefined : "mention node is missing a canonical reference"
	}
	return node.resourceId ? undefined : "resource node is missing a resource id"
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
		diagnostics.push({ code, message, documentId, ...ids })

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
		if (!binding.expectedContentHash) {
			report("semantic_input_resource_invalid", "resource binding is missing the frozen content hash", {
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
