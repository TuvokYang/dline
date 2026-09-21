import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { lexSemanticInput } from "@shared/input-semantics/lexer"

/** A submission from a client that has no semantic composer. */
export interface LegacyInput {
	readonly text?: string
	readonly images?: readonly string[]
	readonly files?: readonly string[]
}

/**
 * The single upgrade path for input that arrives without a document.
 *
 * Legacy text is lexed exactly once, here, against the current catalog. No other
 * entry point may run a parser, so a legacy client and a composer client reach
 * admission through the same structure.
 *
 * Legacy `images` and `files` remain attachments on the envelope: they become
 * task-owned resource nodes only once the resource service owns their local copy.
 */
export class LegacyInputAdapter {
	constructor(
		private readonly catalog: () => InputSemanticCatalog,
		private readonly nextDocumentId: () => string,
	) {}

	adapt(input: LegacyInput): SemanticInputDocument {
		return lexSemanticInput(input.text ?? "", {
			catalog: this.catalog(),
			documentId: this.nextDocumentId(),
			// A legacy client has no way to confirm a candidate, so its text keeps
			// the behaviour users already rely on: a typed command activates.
			activation: "auto",
		})
	}
}
