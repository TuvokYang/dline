import { semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import { SemanticInputDiagnostic as WireDiagnostic } from "@shared/proto/dline/input"
import { describe, expect, it } from "vitest"
import { fromProtoSemanticInputDiagnostic, toProtoSemanticInputDiagnostic } from "../diagnostic"

describe("semantic input diagnostic proto conversion", () => {
    it("round-trips the code, message and the full locator", () => {
        const diagnostic = semanticInputDiagnostic("semantic_input_resource_changed", "resource content no longer matches", {
            documentId: "doc-1",
            entityId: "e2",
            resourceId: "r1",
        })

        const wire = WireDiagnostic.decode(WireDiagnostic.encode(toProtoSemanticInputDiagnostic(diagnostic)).finish())

        expect(fromProtoSemanticInputDiagnostic(wire)).toEqual(diagnostic)
    })

    it("keeps an absent locator field absent", () => {
        const diagnostic = semanticInputDiagnostic("semantic_input_catalog_stale", "catalog moved on", { documentId: "doc-1" })

        const decoded = fromProtoSemanticInputDiagnostic(toProtoSemanticInputDiagnostic(diagnostic))

        expect(decoded).not.toHaveProperty("entityId")
        expect(decoded).not.toHaveProperty("resourceId")
    })

    it("drops a code this build does not know instead of inventing one", () => {
        const wire = WireDiagnostic.create({ code: "semantic_input_from_the_future", message: "x", documentId: "doc-1" })

        expect(fromProtoSemanticInputDiagnostic(wire)).toBeUndefined()
    })

    it("sanitizes a received message again", () => {
        const wire = WireDiagnostic.create({
            code: "semantic_input_resource_missing",
            message: "missing /home/alice/notes.txt",
            documentId: "doc-1",
        })

        expect(fromProtoSemanticInputDiagnostic(wire)?.message).toBe("missing [path]")
    })
})
