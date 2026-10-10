import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { lexSemanticInput } from "@shared/input-semantics/lexer"

/** A submission from a client that has no semantic composer. */
export interface LegacyInput {
    readonly text?: string
    readonly images?: readonly string[]
    readonly files?: readonly string[]
}

/** An upgraded legacy submission, paired with the catalog it was lexed against. */
export interface LegacyAdaptation {
    readonly document: SemanticInputDocument
    /**
     * The exact catalog that produced this document.
     *
     * Admission has to review the document against this snapshot rather than
     * whatever is current by then. Discovery runs on its own schedule, so a
     * capability scan landing between lexing and admission would otherwise
     * declare a document stale against a catalog it was never composed for, and
     * the submission would be refused a millisecond after it was parsed.
     */
    readonly catalog: InputSemanticCatalog
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
        private readonly catalog: () => Promise<InputSemanticCatalog>,
        private readonly nextDocumentId: () => string,
    ) {}

    async adapt(input: LegacyInput): Promise<LegacyAdaptation> {
        const catalog = await this.catalog()
        return {
            catalog,
            document: lexSemanticInput(input.text ?? "", {
                catalog,
                documentId: this.nextDocumentId(),
                // A legacy client has no way to confirm a candidate, so its text keeps
                // the behaviour users already rely on: a typed command activates.
                activation: "auto",
            }),
        }
    }
}
