import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"

/**
 * Pre-subscription baseline.
 *
 * The built-ins are always valid, so a composer can render before discovery
 * answers; revision 0 marks that no backend catalog has arrived yet.
 */
export const INITIAL_INPUT_SEMANTIC_CATALOG: InputSemanticCatalog = {
	revision: 0,
	descriptors: BUILTIN_INPUT_SEMANTICS,
}

/**
 * Accept an incoming catalog only when it is not older than the cached one.
 *
 * Deliveries can interleave while a controller republishes, and regressing to
 * an older revision would reintroduce a capability the backend withdrew.
 */
export function acceptCatalogRevision(current: InputSemanticCatalog, incoming: InputSemanticCatalog): InputSemanticCatalog {
	return incoming.revision >= current.revision ? incoming : current
}
