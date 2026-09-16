import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The packaging script is a standalone ESM entry that resolves its channel at
 * import time and calls vsce, so it cannot be imported here without packaging.
 * These tests therefore pin the release contract at the source level: the rules
 * below are the ones a mis-tagged or under-documented release would violate.
 */

const PROJECT_ROOT = process.cwd()

async function readPackageVsix(): Promise<string> {
	return fs.readFile(path.join(PROJECT_ROOT, "scripts/package-vsix.mjs"), "utf8")
}

describe("package-vsix release channels", () => {
	it("recognises only the two supported release tag formats", async () => {
		const source = await readPackageVsix()

		expect(source).toContain("/^v(\\d+\\.\\d+\\.\\d+)$/")
		expect(source).toContain("/^dev-v(\\d+\\.\\d+\\.\\d+)$/")
		// A bare exact-match check would accept dev-v* as a production tag.
		expect(source).not.toMatch(/function isOnTag\b/)
	})

	it("names each channel distinctly", async () => {
		const source = await readPackageVsix()

		expect(source).toContain('const PREVIEW_SUFFIX = "-preview"')
		expect(source).toContain('const INSIDERS_SUFFIX = "-insiders"')
		expect(source).toContain('const PREVIEW_DISPLAY_SUFFIX = " (Preview)"')
		expect(source).toContain('const INSIDERS_DISPLAY_SUFFIX = " (Insiders)"')
	})

	it("derives the insiders patch from a unix timestamp", async () => {
		const source = await readPackageVsix()

		expect(source).toMatch(/\$\{major\}\.\$\{minor\}\.\$\{Math\.floor\(Date\.now\(\) \/ 1000\)\}/)
	})

	it("gates tagged channels on version and changelog consistency", async () => {
		const source = await readPackageVsix()

		expect(source).toContain("assertReleaseVersionConsistency")
		expect(source).toContain("CHANGELOG.md")
		expect(source).toContain("CHANGELOG_en.md")
		expect(source).toContain("changelogDocumentsVersion")
	})

	it("rejects untagged main and unknown branches instead of guessing a channel", async () => {
		const source = await readPackageVsix()

		expect(source).toContain("main has no release tag")
		expect(source).toContain("has no packaging channel")
		expect(source).toContain("must live on main")
		expect(source).toContain("must live on dev")
	})

	it("restores package.json even when packaging aborts", async () => {
		const source = await readPackageVsix()

		expect(source).toContain("cleanups.defer(")
		expect(source).toContain("Restoring original package.json")
	})
})

describe("changelog language editions", () => {
	it("documents the current package version in both editions", async () => {
		const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8")) as { version: string }
		const heading = `## [${pkg.version}]`

		for (const relativePath of ["CHANGELOG.md", "docs/changelog/CHANGELOG_en.md"]) {
			const content = await fs.readFile(path.join(PROJECT_ROOT, relativePath), "utf8")
			const hasHeading = content.split(/\r?\n/).some((line) => line.trim() === heading)
			expect(hasHeading, `${relativePath} must contain '${heading}'`).toBe(true)
		}
	})
})
