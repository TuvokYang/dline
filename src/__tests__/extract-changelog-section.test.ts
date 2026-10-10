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

	it.each([
		["## [1.2.2]\n- old\n", "CHANGELOG section '1.2.3' was not found."],
		["## [1.2.3]\n\n## [1.2.2]\n- old\n", "CHANGELOG section '1.2.3' is empty."],
	])("fails closed when release notes cannot be produced", (source, message) => {
		expect(() => extractChangelogSection(source, "1.2.3")).toThrow(message)
	})
})
