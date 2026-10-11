import { type SemanticInputDiagnostic, semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import {
    type FileNodeOrigin,
    type ResourceInputNode,
    resourceRefOf,
    type SemanticInputDocument,
} from "@shared/input-semantics/document"
import type { InputResourceKind } from "./InputResourceClassifier"
import type { InputResourceStore } from "./InputResourceStore"
import type { SemanticResourceVerifierPort } from "./SemanticInputAdmissionService"

/** The store operation admission needs: verification without reading the bytes. */
export type ResourceResolver = Pick<InputResourceStore, "resolve">

/**
 * Verifies a document's resources against the store that owns them.
 *
 * The store re-checks owner, identity, generation, size, media type and the
 * content hash; this adds the one check only the document can make - that a
 * node shows the kind of resource it claims. An image node backed by a text
 * file would otherwise reach the provider as an image block, and a file node
 * claiming to be pasted text would show a stored upload as something typed.
 */
export class StoreResourceVerifier implements SemanticResourceVerifierPort {
    constructor(private readonly store: () => ResourceResolver) {}

    async verify(document: SemanticInputDocument, node: ResourceInputNode): Promise<readonly SemanticInputDiagnostic[]> {
        const locator = { documentId: document.documentId, entityId: node.entityId, resourceId: node.resourceId }
        const ref = resourceRefOf(document, node)
        if (!ref)
            return [semanticInputDiagnostic("semantic_input_resource_missing", "resource is not bound to the document", locator)]

        const resolved = await this.store().resolve(ref)
        if (!resolved.ok) return [semanticInputDiagnostic(resolved.failure.code, resolved.failure.message, locator)]

        const recordKind = resolved.value.record.kind
        if (node.kind === "image" && recordKind !== "image") {
            return [
                semanticInputDiagnostic(
                    "semantic_input_resource_invalid_mime",
                    "image node does not reference an image",
                    locator,
                ),
            ]
        }
        if (node.kind === "file" && recordKind !== fileRecordKind(node.fileOrigin)) {
            return [
                semanticInputDiagnostic(
                    "semantic_input_resource_invalid",
                    `file node of origin ${node.fileOrigin} references a ${recordKind} resource`,
                    locator,
                ),
            ]
        }
        return []
    }
}

/** Pasted text is staged as its own kind; every other file origin holds file bytes. */
function fileRecordKind(origin: FileNodeOrigin): InputResourceKind {
    return origin === "pasted_text" ? "pasted_text" : "file"
}
