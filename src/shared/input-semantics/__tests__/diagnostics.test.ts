import { describe, expect, it } from "vitest"
import {
    isSemanticInputDiagnosticCode,
    SEMANTIC_INPUT_DIAGNOSTIC_CODES,
    sanitizeDiagnosticText,
    semanticInputDiagnostic,
} from "../diagnostics"

describe("semantic input diagnostics", () => {
    it("keeps the document, entity and resource locator of the problem", () => {
        const diagnostic = semanticInputDiagnostic("semantic_input_resource_changed", "resource content no longer matches", {
            documentId: "doc-1",
            entityId: "e2",
            resourceId: "r1",
        })

        expect(diagnostic).toEqual({
            code: "semantic_input_resource_changed",
            message: "resource content no longer matches",
            documentId: "doc-1",
            entityId: "e2",
            resourceId: "r1",
        })
    })

    it("omits locator fields the problem does not have instead of writing undefined", () => {
        const diagnostic = semanticInputDiagnostic("semantic_input_catalog_stale", "catalog moved on", { documentId: "doc-1" })

        expect(diagnostic).not.toHaveProperty("entityId")
        expect(diagnostic).not.toHaveProperty("resourceId")
    })

    it("never carries image data, absolute paths, bearer tokens or long encoded payloads", () => {
        const message = [
            "failed to stage data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
            "from C:\\Users\\alice\\secret\\notes.pdf",
            "and /home/alice/.ssh/id_rsa",
            "with Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
            `payload ${"QUJD".repeat(40)}`,
        ].join(" ")

        const sanitized = sanitizeDiagnosticText(message)

        expect(sanitized).not.toContain("iVBORw0KGgo")
        expect(sanitized).not.toContain("alice")
        expect(sanitized).not.toContain("sk-live")
        expect(sanitized).not.toContain("QUJDQUJD")
        expect(sanitized).toContain("[data-url]")
        expect(sanitized).toContain("[path]")
        expect(sanitized).toContain("Bearer [redacted]")
    })

    it("redacts whole paths whose directory names contain spaces", () => {
        const sanitized = sanitizeDiagnosticText(
            [
                "read C:\\Users\\Alice Smith\\key.pem failed;",
                "share \\\\server\\Alice Smith\\secret.txt is gone;",
                "home /home/Alice Smith/secret.txt moved;",
                "mac /Users/Alice Smith/Library/notes.txt too",
            ].join(" "),
        )

        expect(sanitized).not.toContain("Alice")
        expect(sanitized).not.toContain("Smith")
        expect(sanitized).not.toContain("secret.txt")
        expect(sanitized).not.toContain("key.pem")
        expect(sanitized).toBe("read [path] failed; share [path] is gone; home [path] moved; mac [path] too")
    })

    it("redacts root files and file URLs", () => {
        expect(sanitizeDiagnosticText("cannot open /secret.txt now")).toBe("cannot open [path] now")
        expect(sanitizeDiagnosticText("cannot open file:///home/u/secret now")).toBe("cannot open [path] now")
        expect(sanitizeDiagnosticText("cannot open file://host/share/a.txt now")).toBe("cannot open [path] now")
    })

    it("redacts data URLs without a media type", () => {
        expect(sanitizeDiagnosticText("got data:,hello%20world here")).toBe("got [data-url] here")
        expect(sanitizeDiagnosticText("got data:;base64,SGVsbG8= here")).toBe("got [data-url] here")
    })

    it("redacts Basic credentials and short provider keys", () => {
        const sanitized = sanitizeDiagnosticText("auth Basic dXNlcjpwYXNz failed with sk-ant-abc123def456ghi7")

        expect(sanitized).toBe("auth Basic [redacted] failed with [redacted]")
    })

    it("keeps ordinary web URLs readable", () => {
        expect(sanitizeDiagnosticText("see https://example.com/docs/input for details")).toBe(
            "see https://example.com/docs/input for details",
        )
    })

    it("recognizes exactly the declared diagnostic codes", () => {
        expect(SEMANTIC_INPUT_DIAGNOSTIC_CODES).toContain("semantic_input_resource_missing")
        expect(isSemanticInputDiagnosticCode("semantic_input_resource_missing")).toBe(true)
        expect(isSemanticInputDiagnosticCode("semantic_input_made_up")).toBe(false)
    })

    it("keeps command names and workspace-relative wording readable", () => {
        expect(sanitizeDiagnosticText("command /compact was typed as /compact, expected composable")).toBe(
            "command /compact was typed as /compact, expected composable",
        )
    })

    it("bounds the message length so a runaway message cannot smuggle content", () => {
        const sanitized = sanitizeDiagnosticText("x ".repeat(2000))

        expect(sanitized.length).toBeLessThanOrEqual(500)
    })

    it("sanitizes the message a builder receives", () => {
        const diagnostic = semanticInputDiagnostic("semantic_input_resource_stage_failed", "could not read /var/tmp/a/b.txt", {
            documentId: "doc-1",
        })

        expect(diagnostic.message).toBe("could not read [path]")
    })
})
