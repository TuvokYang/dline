import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
// @ts-expect-error -- packaging scripts are plain ESM without type declarations.
import { pinRepositoryLinks } from "../../scripts/marketplace-readme.mjs"

/**
 * Links and images inside the packaged VSIX README must resolve to the
 * revision that was actually shipped.
 *
 * README.marketplace.md links to repository files with relative paths. Left
 * alone, vsce resolves them against `blob/HEAD` / `raw/HEAD` - the default
 * branch - so a Preview or Insiders VSIX built from `dev` showed another
 * revision's changelog, and a demo that exists only on `dev` rendered broken.
 */

const PROJECT_ROOT = process.cwd()
const REPOSITORY_URL = "https://github.com/TuvokYang/Dline"

describe("marketplace README repository links", () => {
	it("pins page links to blob and images to raw at the packaged ref", () => {
		const source = [
			"[中文](README_zh.md) · [Changelog](docs/changelog/CHANGELOG_en.md#094)",
			'<p align="center"><img src="assets/docs/marketplace/r1-hero.gif" width="1200" alt="demo" /></p>',
			"![icon](assets/icons/icon.png)",
			'<a href="LICENSE">license</a>',
		].join("\n")

		const pinned = pinRepositoryLinks(source, REPOSITORY_URL, "dev-v0.9.4")

		expect(pinned).toContain(`[中文](${REPOSITORY_URL}/blob/dev-v0.9.4/README_zh.md)`)
		expect(pinned).toContain(`[Changelog](${REPOSITORY_URL}/blob/dev-v0.9.4/docs/changelog/CHANGELOG_en.md#094)`)
		expect(pinned).toContain(`src="${REPOSITORY_URL}/raw/dev-v0.9.4/assets/docs/marketplace/r1-hero.gif"`)
		expect(pinned).toContain(`![icon](${REPOSITORY_URL}/raw/dev-v0.9.4/assets/icons/icon.png)`)
		expect(pinned).toContain(`href="${REPOSITORY_URL}/blob/dev-v0.9.4/LICENSE"`)
	})

	it("leaves absolute URLs, anchors and fenced code untouched", () => {
		const source = [
			"[Cline](https://github.com/cline/cline) · [docs](https://docs.dline.cc/) · [top](#why-dline)",
			"```gitignore",
			"[not a link](secrets/)",
			"```",
		].join("\n")

		expect(pinRepositoryLinks(source, REPOSITORY_URL, "abc123")).toBe(source)
	})

	it("rejects a link that escapes the repository", () => {
		expect(() => pinRepositoryLinks("[x](../outside.md)", REPOSITORY_URL, "abc123")).toThrow(/outside the repository/)
	})

	it("refuses to pin without a repository or a ref", () => {
		expect(() => pinRepositoryLinks("[x](LICENSE)", null, "abc123")).toThrow(/repository URL/)
		expect(() => pinRepositoryLinks("[x](LICENSE)", REPOSITORY_URL, "")).toThrow(/No ref/)
	})

	it("pins every repository link in the real marketplace README to existing files", async () => {
		const readme = await fs.readFile(path.join(PROJECT_ROOT, "README.marketplace.md"), "utf8")
		const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"))
		const declaredUrl = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
		expect(declaredUrl, "package.json must declare a repository URL").toBeTruthy()
		const repositoryUrl = declaredUrl.replace(/^git\+/, "").replace(/\.git$/, "")

		// The marketplace edition is the English listing; no link may name a branch.
		expect(readme).toContain("English · [中文](README_zh.md)")
		expect(readme).not.toMatch(/\/(?:blob|raw|tree)\/main\//)

		const pinned = pinRepositoryLinks(readme, repositoryUrl, "dev-v9.9.9")
		const escaped = repositoryUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		const targets = [...pinned.matchAll(new RegExp(`${escaped}/(?:blob|raw)/dev-v9\\.9\\.9/([^)"'#?\\s]+)`, "g"))].map(
			(match) => match[1],
		)

		expect(targets.length).toBeGreaterThan(10)
		for (const target of targets) {
			await expect(
				fs.access(path.join(PROJECT_ROOT, target)),
				`${target} must exist in the repository`,
			).resolves.toBeUndefined()
		}
	})
})
