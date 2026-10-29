import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { describe, expect, it } from "vitest"
import type { ComposerTextSource } from "./input/semantic-composer/model"
import { captureComposerSend } from "./input/semantic-composer/send-draft"
import { isReportBugSemanticDocument, reportBugDetails, shouldUseLocalReportBugFallback } from "./report-bug-fallback"

const catalog: InputSemanticCatalog = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS }

function capture(text: string, source: ComposerTextSource = "typed") {
    const result = captureComposerSend([{ kind: "text", text, source }], { catalog, documentId: crypto.randomUUID() })
    if (!result.ok) throw new Error(`unexpected send block: ${result.block}`)
    return result.draft
}

describe("report bug local fallback", () => {
    it("recognizes the namespaced report command from the complete send projection", () => {
        const command = capture("/cmd:reportbug provider failed")

        expect(command.semanticInput).toBeUndefined()
        expect(isReportBugSemanticDocument(command.semanticDocument)).toBe(true)
        expect(isReportBugSemanticDocument(capture("/reportbug provider failed").semanticDocument)).toBe(true)
    })

    it("sends the same details for every spelling of the command", () => {
        const details = (text: string) => {
            const document = capture(text).semanticDocument
            if (!document) throw new Error("expected a semantic document")
            return reportBugDetails(document)
        }

        expect(details("/cmd:reportbug provider failed")).toBe("provider failed")
        expect(details("/reportbug provider failed")).toBe("provider failed")
        expect(details("/cmd:reportbug")).toBe("")
        expect(details("/reportbug cannot open @/src/app.ts")).toBe("cannot open @/src/app.ts")
    })

    it("does not activate pasted or literal report-looking text", () => {
        expect(isReportBugSemanticDocument(capture("/cmd:reportbug pasted", "pasted").semanticDocument)).toBe(false)
        expect(isReportBugSemanticDocument(capture("/cmd:reportbug selected", "editor_selection").semanticDocument)).toBe(false)
    })

    it("falls back for unavailable Profiles and provider failure interactions", () => {
        expect(shouldUseLocalReportBugFallback({ kind: "create", text: "Create profile" }, undefined)).toBe(true)
        expect(
            shouldUseLocalReportBugFallback(
                { kind: "load_error", text: "Profiles unavailable", detail: "invalid catalog" },
                undefined,
            ),
        ).toBe(true)
        expect(shouldUseLocalReportBugFallback({ kind: "select", reason: "invalid", text: "Select profile" }, undefined)).toBe(
            true,
        )
        expect(
            shouldUseLocalReportBugFallback(
                { kind: "selected", text: "Ready", profile: { id: "p", name: "P" } as never },
                "profile_failure",
            ),
        ).toBe(true)
        expect(
            shouldUseLocalReportBugFallback(
                { kind: "selected", text: "Ready", profile: { id: "p", name: "P" } as never },
                "error_retry",
            ),
        ).toBe(true)
        expect(
            shouldUseLocalReportBugFallback(
                { kind: "selected", text: "Ready", profile: { id: "p", name: "P" } as never },
                undefined,
            ),
        ).toBe(false)
    })
})
