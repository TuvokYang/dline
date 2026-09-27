import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { remarkBaseLinks, toPrefix, withBase } from "../../src/plugins/remark-base-links.mjs"

describe("toPrefix", () => {
	it("maps the root base to an empty prefix", () => {
		assert.equal(toPrefix("/"), "")
		assert.equal(toPrefix(""), "")
	})

	it("drops the trailing slash and keeps exactly one leading slash", () => {
		assert.equal(toPrefix("/dline/"), "/dline")
		assert.equal(toPrefix("dline"), "/dline")
		assert.equal(toPrefix("//docs/v2//"), "/docs/v2")
	})
})

describe("withBase", () => {
	it("prefixes root-relative page and asset URLs", () => {
		assert.equal(withBase("/getting-started/", "/dline"), "/dline/getting-started/")
		assert.equal(withBase("/zh-cn/", "/dline"), "/dline/zh-cn/")
		assert.equal(withBase("/images/logo.png", "/dline"), "/dline/images/logo.png")
	})

	it("is idempotent for URLs that already carry the base", () => {
		assert.equal(withBase("/dline/guide/", "/dline"), "/dline/guide/")
		assert.equal(withBase("/dline", "/dline"), "/dline")
	})

	it("does not mistake a sibling path that shares the base text for a prefixed URL", () => {
		assert.equal(withBase("/dlinex/", "/dline"), "/dline/dlinex/")
	})

	it("leaves protocol-relative, absolute, hash and relative URLs untouched", () => {
		for (const url of ["//cdn.example.com/a.js", "https://example.com/", "mailto:a@b.c", "#usage", "./local/", "../up/"]) {
			assert.equal(withBase(url, "/dline"), url)
		}
	})

	it("is a no-op for a root deployment", () => {
		assert.equal(withBase("/guide/", ""), "/guide/")
	})
})

describe("remarkBaseLinks", () => {
	/** @returns {any} */
	const sampleTree = () => ({
		type: "root",
		children: [
			{ type: "paragraph", children: [{ type: "link", url: "/guide/", children: [] }] },
			{ type: "image", url: "/img/a.png" },
			{ type: "definition", url: "/ref/" },
			{ type: "link", url: "https://example.com/" },
			{
				type: "mdxJsxFlowElement",
				attributes: [
					{ type: "mdxJsxAttribute", name: "href", value: "/card/" },
					{ type: "mdxJsxAttribute", name: "title", value: "/not-a-link/" },
					{
						type: "mdxJsxAttribute",
						name: "link",
						value: { type: "mdxJsxAttributeValueExpression", value: "'/expr/'" },
					},
				],
				children: [],
			},
			{ type: "html", value: '<a href="/raw/">x</a><img src=\'/raw.png\'><a href="//cdn.example.com/">y</a>' },
		],
	})

	it("prefixes every root-relative URL in links, images, definitions, JSX and raw HTML", () => {
		const tree = sampleTree()
		remarkBaseLinks({ base: "/dline/" })(tree)
		const [paragraph, image, definition, external, jsx, html] = tree.children
		assert.equal(paragraph.children[0].url, "/dline/guide/")
		assert.equal(image.url, "/dline/img/a.png")
		assert.equal(definition.url, "/dline/ref/")
		assert.equal(external.url, "https://example.com/")
		assert.equal(jsx.attributes[0].value, "/dline/card/")
		assert.equal(jsx.attributes[1].value, "/not-a-link/", "non-link attributes are not URLs")
		assert.deepEqual(jsx.attributes[2].value, { type: "mdxJsxAttributeValueExpression", value: "'/expr/'" })
		assert.equal(html.value, '<a href="/dline/raw/">x</a><img src=\'/dline/raw.png\'><a href="//cdn.example.com/">y</a>')
	})

	it("produces the same tree when applied twice", () => {
		const once = sampleTree()
		remarkBaseLinks({ base: "/dline/" })(once)
		const twice = structuredClone(once)
		remarkBaseLinks({ base: "/dline/" })(twice)
		assert.deepEqual(twice, once)
	})

	it("leaves content unchanged for the root base", () => {
		const tree = sampleTree()
		remarkBaseLinks({ base: "/" })(tree)
		assert.deepEqual(tree, sampleTree())
	})
})
