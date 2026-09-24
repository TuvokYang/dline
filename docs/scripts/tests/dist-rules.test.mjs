import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { checkBuiltFile, findChineseLeak, findUnprefixedUrls, localeOfBuiltFile, requiredEntryPages } from "../lib/dist-rules.mjs"

const BASE = "/dline"

describe("requiredEntryPages", () => {
	it("expects a home page for every locale edition", () => {
		assert.deepEqual(requiredEntryPages(), ["index.html", "en/index.html"])
	})
})

describe("localeOfBuiltFile", () => {
	it("attributes files below a locale directory to that locale", () => {
		assert.equal(localeOfBuiltFile("en/index.html"), "en")
		assert.equal(localeOfBuiltFile("en/guide/index.html"), "en")
	})

	it("attributes everything else to the root locale", () => {
		for (const file of ["index.html", "guide/index.html", "english/index.html", "en.html", "_astro/page.css", "404.html"]) {
			assert.equal(localeOfBuiltFile(file), "root", file)
		}
	})
})

describe("findUnprefixedUrls", () => {
	it("accepts base-prefixed, absolute, protocol-relative and fragment URLs", () => {
		const html = [
			'<a href="/dline/en/">en</a>',
			'<a href="/dline">home</a>',
			'<link rel="canonical" href="https://tuvokyang.github.io/dline/">',
			'<script src="//cdn.example.com/a.js"></script>',
			'<a href="#top">top</a>',
			'<img src="data:image/png;base64,AAAA">',
		].join("")
		assert.deepEqual(findUnprefixedUrls(html, BASE), [])
	})

	it("reports root-relative URLs that miss the base", () => {
		const html = '<img src="/_astro/logo.svg"><a href="/dlinex/">x</a><a href="/_astro/logo.svg">dup</a>'
		assert.deepEqual(findUnprefixedUrls(html, BASE), ["/_astro/logo.svg", "/dlinex/"])
	})

	it("checks srcset candidates, CSS url() values and refresh redirects", () => {
		const html = [
			'<img srcset="/a.png 1x, /dline/b.png 2x">',
			"<style>.x{background:url('/bg.png')}.y{background:url(data:image/svg+xml;utf8,x)}</style>",
			'<meta http-equiv="refresh" content="0;url=/old/">',
		].join("")
		assert.deepEqual(findUnprefixedUrls(html, BASE), ["/old/", "/bg.png", "/a.png"])
	})

	it("ignores inline script bodies", () => {
		assert.deepEqual(findUnprefixedUrls('<script>fetch("/api/", { href: "/x/" })</script>', BASE), [])
	})

	it("reports nothing for a root deployment", () => {
		assert.deepEqual(findUnprefixedUrls('<img src="/_astro/logo.svg">', ""), [])
	})
})

describe("findChineseLeak", () => {
	it("accepts English prose", () => {
		assert.equal(findChineseLeak("<main><p>Hello</p></main>"), undefined)
	})

	it("reports Chinese in visible text and in UI attributes", () => {
		assert.match(findChineseLeak("<main><p>Install 扩展 now</p></main>") ?? "", /扩展/)
		assert.match(findChineseLeak('<button title="复制到剪贴板"></button>') ?? "", /复制到剪贴板/)
	})

	it("ignores code, scripts and the language picker", () => {
		const html = [
			'<pre><code>echo "你好"</code></pre>',
			"<p>Run <code>中文参数</code></p>",
			"<script>const label = '中文'</script>",
			'<starlight-lang-select><option value="/dline/">简体中文</option></starlight-lang-select>',
		].join("")
		assert.equal(findChineseLeak(html), undefined)
	})
})

describe("checkBuiltFile", () => {
	it("flags Chinese only on non-Chinese HTML pages", () => {
		const html = "<p>终端窗口</p>"
		assert.equal(checkBuiltFile({ relativePath: "en/guide/index.html", text: html, basePrefix: BASE }).length, 1)
		assert.deepEqual(checkBuiltFile({ relativePath: "guide/index.html", text: html, basePrefix: BASE }), [])
	})

	it("checks base-safe URLs in HTML and CSS but not in scripts", () => {
		const css = checkBuiltFile({ relativePath: "_astro/a.css", text: "a{background:url(/x.png)}", basePrefix: BASE })
		assert.equal(css.length, 1)
		assert.match(css[0]?.message ?? "", /misses the site base \/dline\/: \/x\.png/)
		assert.deepEqual(checkBuiltFile({ relativePath: "_astro/a.js", text: 'const u = "/x/"', basePrefix: BASE }), [])
	})

	it("flags forbidden references in any text file", () => {
		const issues = checkBuiltFile({ relativePath: "_astro/a.js", text: "load('https://fonts.googleapis.com/css')", basePrefix: BASE })
		assert.deepEqual(
			issues.map((issue) => issue.message),
			["Google Fonts request"],
		)
	})
})
