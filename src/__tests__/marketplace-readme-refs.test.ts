import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
// @ts-expect-error -- packaging scripts are plain ESM without type declarations.
import { rewriteRepositoryRefs } from "../../scripts/marketplace-readme.mjs"

/**
 * Documentation links inside the packaged VSIX must point at the revision that
 * was actually shipped.
 *
 * README.marketplace.md is authored against the default branch, so every
 * self-referencing link is committed as `/blob/main/...`. A preview, insiders,
 * or dev VSIX ships code from another ref, and those links then resolve to
 * whatever `main` happens to contain - a changelog for a different release, or
 * a 404 for a document that exists only on the packaged branch.
 */

const PROJECT_ROOT = process.cwd()
const REPOSITORY_URL = "https://github.com/TuvokYang/Dline"

describe("marketplace README repository refs", () => {
	it("pins self-referencing links to the packaged ref", () => {
		const source = [
			"[English](https://github.com/TuvokYang/Dline/blob/main/README_en.md)",
			"[变更日志](https://github.com/TuvokYang/Dline/blob/main/CHANGELOG.md)",
			"![demo](https://github.com/TuvokYang/Dline/raw/main/assets/docs/demo.gif)",
			"[docs](https://github.com/TuvokYang/Dline/tree/main/docs)",
		].join("\n")

		const rewritten = rewriteRepositoryRefs(source, REPOSITORY_URL, "dev-v0.9.4")

		expect(rewritten).toContain("/blob/dev-v0.9.4/README_en.md")
		expect(rewritten).toContain("/blob/dev-v0.9.4/CHANGELOG.md")
		expect(rewritten).toContain("/raw/dev-v0.9.4/assets/docs/demo.gif")
		expect(rewritten).toContain("/tree/dev-v0.9.4/docs")
		expect(rewritten).not.toContain("/main/")
	})

	it("leaves third-party repository links untouched", () => {
		// Several READMEs cite upstream projects whose own default branch is main.
		// Rewriting those would point users at a branch of a repository we do not own.
		const source = [
			"[ours](https://github.com/TuvokYang/Dline/blob/main/LICENSE)",
			"[theirs](https://github.com/microsoft/vscode/blob/main/README.md)",
		].join("\n")

		const rewritten = rewriteRepositoryRefs(source, REPOSITORY_URL, "abc123")

		expect(rewritten).toContain("https://github.com/TuvokYang/Dline/blob/abc123/LICENSE")
		expect(rewritten).toContain("https://github.com/microsoft/vscode/blob/main/README.md")
	})

	it("keeps the authored links for a production build", () => {
		const source = "[changelog](https://github.com/TuvokYang/Dline/blob/main/CHANGELOG.md)"

		// A production VSIX ships what main contains, so the authored links are
		// already correct and must not be churned into a commit SHA.
		expect(rewriteRepositoryRefs(source, REPOSITORY_URL, "main")).toBe(source)
		expect(rewriteRepositoryRefs(source, REPOSITORY_URL, null)).toBe(source)
		expect(rewriteRepositoryRefs(source, null, "dev")).toBe(source)
	})

	it("does not rewrite a branch whose name merely starts with main", () => {
		const source = "[x](https://github.com/TuvokYang/Dline/blob/maintenance/NOTES.md)"

		expect(rewriteRepositoryRefs(source, REPOSITORY_URL, "abc123")).toBe(source)
	})

	it("rewrites every self-referencing link in the real marketplace README", async () => {
		const readme = await fs.readFile(path.join(PROJECT_ROOT, "README.marketplace.md"), "utf8")
		const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"))
		const declaredUrl = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
		expect(declaredUrl, "package.json must declare a repository URL").toBeTruthy()
		const repositoryUrl = declaredUrl.replace(/^git\+/, "").replace(/\.git$/, "")

		const rewritten = rewriteRepositoryRefs(readme, repositoryUrl, "dev-v9.9.9")

		// Guards the manifest URL and the authored links staying in agreement: a
		// casing or path change in either would silently disable the rewrite.
		expect(rewritten).not.toBe(readme)
		expect(rewritten).not.toMatch(new RegExp(`${repositoryUrl}/(?:blob|raw|tree)/main/`, "i"))
	})
})
