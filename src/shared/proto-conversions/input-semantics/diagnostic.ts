import {
    isSemanticInputDiagnosticCode,
    type SemanticInputDiagnostic,
    semanticInputDiagnostic,
} from "@shared/input-semantics/diagnostics"
import { SemanticInputDiagnostic as WireDiagnostic } from "@shared/proto/dline/input"

export function toProtoSemanticInputDiagnostic(diagnostic: SemanticInputDiagnostic): WireDiagnostic {
    return WireDiagnostic.create({
        code: diagnostic.code,
        message: diagnostic.message,
        documentId: diagnostic.documentId,
        entityId: diagnostic.entityId,
        resourceId: diagnostic.resourceId,
    })
}

/**
 * Decode a wire diagnostic, or undefined when its code is not one this build knows.
 *
 * The message is sanitized again: a diagnostic is only trusted to be free of
 * paths and payloads when this build's sanitizer has seen it.
 */
export function fromProtoSemanticInputDiagnostic(wire: WireDiagnostic): SemanticInputDiagnostic | undefined {
    if (!isSemanticInputDiagnosticCode(wire.code)) return undefined
    return semanticInputDiagnostic(wire.code, wire.message, {
        documentId: wire.documentId,
        entityId: wire.entityId,
        resourceId: wire.resourceId,
    })
}
