import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { pagePath, ROOT_LOCALE, SECONDARY_LOCALES, toPageIdentity } from "../lib/content-files.mjs"

describe("toPageIdentity", () => {
	it("derives the secondary locales from the shared locale definition", () => {
		assert.deepEqual([...SECONDARY_LOCALES], ["en"])
	})

	it("maps index pages to the locale home slug", () => {
		assert.deepEqual(toPageIdentity("index.mdx"), { relativePath: "index.mdx", locale: ROOT_LOCALE, slug: "" })
		assert.deepEqual(toPageIdentity("en/index.mdx"), { relativePath: "en/index.mdx", locale: "en", slug: "" })
	})

	it("lower-cases slugs, strips extensions and normalizes Windows separators", () => {
		assert.deepEqual(toPageIdentity("en\\Usage\\IDE.md"), { relativePath: "en/Usage/IDE.md", locale: "en", slug: "usage/ide" })
		assert.deepEqual(toPageIdentity("guide/index.mdx"), { relativePath: "guide/index.mdx", locale: ROOT_LOCALE, slug: "guide" })
	})

	it("only treats an exact locale directory as a locale", () => {
		assert.equal(toPageIdentity("english/intro.mdx")?.locale, ROOT_LOCALE)
		assert.equal(toPageIdentity("english/intro.mdx")?.slug, "english/intro")
	})

	it("ignores files that Starlight does not publish as pages", () => {
		assert.equal(toPageIdentity("images/logo.png"), undefined)
		assert.equal(toPageIdentity("data.json"), undefined)
	})
})

describe("pagePath", () => {
	it("builds base-free site paths with a trailing slash", () => {
		assert.equal(pagePath({ relativePath: "index.mdx", locale: ROOT_LOCALE, slug: "" }), "/")
		assert.equal(pagePath({ relativePath: "a/b.mdx", locale: ROOT_LOCALE, slug: "a/b" }), "/a/b/")
		assert.equal(pagePath({ relativePath: "en/index.mdx", locale: "en", slug: "" }), "/en/")
		assert.equal(pagePath({ relativePath: "en/a.mdx", locale: "en", slug: "a" }), "/en/a/")
	})
})
