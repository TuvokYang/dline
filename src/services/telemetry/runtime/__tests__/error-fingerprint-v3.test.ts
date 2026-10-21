import { withDiagnosticSite } from "@shared/errors/diagnostic-site"
import { describe, expect, it } from "vitest"
import { normalizeRuntimeError } from "../error-normalizer"
import { exceptionAttributes } from "../exception-attributes"

// Every error below is created in this one file, which stands in for a bundle:
// their source frames name the same file, so only the site can tell them apart.
describe("fingerprint v3 (WS-109 SC-3)", () => {
    it("separates plain errors caught at different sites of one file", () => {
        const search = normalizeRuntimeError(withDiagnosticSite(new Error("a"), "ripgrep.search"))
        const history = normalizeRuntimeError(withDiagnosticSite(new Error("b"), "task_history.update"))
        const untagged = normalizeRuntimeError(new Error("c"))

        expect(new Set([search.fingerprint, history.fingerprint, untagged.fingerprint]).size).toBe(3)
    })

    it("keeps one fingerprint for a site whose code moved to another line", () => {
        const before = normalizeRuntimeError(withDiagnosticSite(new Error("first"), "mcp.connect"))

        const after = normalizeRuntimeError(withDiagnosticSite(new Error("second"), "mcp.connect"))

        expect(before.sourceFrame).not.toBe(after.sourceFrame)
        expect(after.fingerprint).toBe(before.fingerprint)
    })

    it("keeps the first site recorded, which is the innermost catch", () => {
        const error = withDiagnosticSite(withDiagnosticSite(new Error("inner"), "ripgrep.search"), "mcp.connect")

        expect(normalizeRuntimeError(error).site).toBe("ripgrep.search")
    })

    it("publishes the site and the grouping version with the fingerprint", () => {
        const attributes = exceptionAttributes(normalizeRuntimeError(withDiagnosticSite(new Error("x"), "ripgrep.search")))

        expect(attributes).toMatchObject({ "error.site": "ripgrep.search", "dline.exception.fingerprint_version": 3 })
        expect(exceptionAttributes(normalizeRuntimeError(new Error("y")))).not.toHaveProperty("error.site")
    })
})
