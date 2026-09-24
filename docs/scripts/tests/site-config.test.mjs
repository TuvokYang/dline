import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { DEFAULT_BASE, DEFAULT_SITE, normalizeBase, normalizeSite, resolveSiteConfig } from "../../site.config.mjs"

describe("normalizeBase", () => {
	it("keeps the root base as a single slash", () => {
		assert.equal(normalizeBase("/"), "/")
		assert.equal(normalizeBase(""), "/")
		assert.equal(normalizeBase("  "), "/")
	})

	it("always yields exactly one leading and one trailing slash", () => {
		assert.equal(normalizeBase("dline"), "/dline/")
		assert.equal(normalizeBase("/dline"), "/dline/")
		assert.equal(normalizeBase("//dline//"), "/dline/")
		assert.equal(normalizeBase(" /docs/v2/ "), "/docs/v2/")
	})
})

describe("normalizeSite", () => {
	it("keeps only the origin so a base path cannot leak in through the site", () => {
		assert.equal(normalizeSite("https://example.com/some/path/?q=1#x"), "https://example.com")
		assert.equal(normalizeSite("http://localhost:4321/"), "http://localhost:4321")
	})

	it("rejects a value that is not an absolute URL", () => {
		assert.throws(() => normalizeSite("example.com"))
	})
})

describe("resolveSiteConfig", () => {
	it("defaults to the GitHub Pages project site of the repository", () => {
		assert.deepEqual(resolveSiteConfig({}), { site: DEFAULT_SITE, base: DEFAULT_BASE })
		assert.equal(DEFAULT_BASE, "/dline/")
	})

	it("honours DOCS_SITE and DOCS_BASE overrides after normalization", () => {
		assert.deepEqual(resolveSiteConfig({ DOCS_SITE: "https://docs.example.com/ignored/", DOCS_BASE: "/" }), {
			site: "https://docs.example.com",
			base: "/",
		})
		assert.deepEqual(resolveSiteConfig({ DOCS_BASE: "fork-name" }).base, "/fork-name/")
	})

	it("treats empty overrides as unset", () => {
		assert.deepEqual(resolveSiteConfig({ DOCS_SITE: "", DOCS_BASE: "" }), { site: DEFAULT_SITE, base: DEFAULT_BASE })
	})
})
