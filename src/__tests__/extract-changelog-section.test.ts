import { describe, expect, it } from "vitest"
import { extractChangelogSection } from "../../scripts/extract-changelog-section.mjs"

describe("extractChangelogSection", () => {
    it("extracts only the requested bracketed version section", () => {
        const changelog = "# Changelog\n\n## [1.2.3]\n\n### Fixes\n- fixed\n\n## [1.2.2]\n- old\n"

        expect(extractChangelogSection(changelog, "1.2.3")).toBe("### Fixes\n- fixed\n")
    })

    it("accepts an unbracketed version heading", () => {
        expect(extractChangelogSection("## 1.2.3\n- shipped\n", "1.2.3")).toBe("- shipped\n")
    })

    it("extracts the rolling Unreleased section", () => {
        const changelog = "## [Unreleased]\n\n### Fixed\n- current\n\n## [1.2.3]\n- shipped\n"

        expect(extractChangelogSection(changelog, "Unreleased")).toBe("### Fixed\n- current\n")
    })

    it("allows an explicitly empty rolling section without weakening release sections", () => {
        const changelog = "## [Unreleased]\n\n## [1.2.3]\n- shipped\n"

        expect(extractChangelogSection(changelog, "Unreleased", { allowEmpty: true })).toBe("")
        expect(() => extractChangelogSection(changelog, "Unreleased")).toThrow("CHANGELOG section 'Unreleased' is empty.")
    })

    it("rejects empty-section tolerance for a versioned release", () => {
        expect(() => extractChangelogSection("## [1.2.3]\n", "1.2.3", { allowEmpty: true })).toThrow(
            "allowEmpty is supported only for the Unreleased changelog section.",
        )
    })

    it.each([
        ["## [1.2.2]\n- old\n", "CHANGELOG section '1.2.3' was not found."],
        ["## [1.2.3]\n\n## [1.2.2]\n- old\n", "CHANGELOG section '1.2.3' is empty."],
    ])("fails closed when release notes cannot be produced", (source, message) => {
        expect(() => extractChangelogSection(source, "1.2.3")).toThrow(message)
    })
})
