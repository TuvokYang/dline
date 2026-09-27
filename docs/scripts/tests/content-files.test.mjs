import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { pagePath, ROOT_LOCALE, SECONDARY_LOCALES, toPageIdentity } from "../lib/content-files.mjs"

describe("toPageIdentity", () => {
	it("derives the secondary locales from the shared locale definition", () => {
		assert.deepEqual([...SECONDARY_LOCALES], ["zh-cn"])
	})

	it("maps index pages to the locale home slug", () => {
		assert.deepEqual(toPageIdentity("index.mdx"), { relativePath: "index.mdx", locale: ROOT_LOCALE, slug: "" })
		assert.deepEqual(toPageIdentity("zh-cn/index.mdx"), { relativePath: "zh-cn/index.mdx", locale: "zh-cn", slug: "" })
	})

	it("lower-cases slugs, strips extensions and normalizes Windows separators", () => {
		assert.deepEqual(toPageIdentity("zh-cn\\Usage\\IDE.md"), {
			relativePath: "zh-cn/Usage/IDE.md",
			locale: "zh-cn",
			slug: "usage/ide",
		})
		assert.deepEqual(toPageIdentity("guide/index.mdx"), {
			relativePath: "guide/index.mdx",
			locale: ROOT_LOCALE,
			slug: "guide",
		})
	})

	it("only treats an exact locale directory as a locale", () => {
		assert.equal(toPageIdentity("zh-cnx/intro.mdx")?.locale, ROOT_LOCALE)
		assert.equal(toPageIdentity("zh-cnx/intro.mdx")?.slug, "zh-cnx/intro")
		assert.equal(toPageIdentity("en/intro.mdx")?.locale, ROOT_LOCALE, "English is the root edition, not a directory")
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
		assert.equal(pagePath({ relativePath: "zh-cn/index.mdx", locale: "zh-cn", slug: "" }), "/zh-cn/")
		assert.equal(pagePath({ relativePath: "zh-cn/a.mdx", locale: "zh-cn", slug: "a" }), "/zh-cn/a/")
	})
})
