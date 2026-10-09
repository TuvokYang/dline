import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parseWhatsNew, WHATS_NEW_SOURCE } from "../../vite-whats-new"

const CHINESE_SOURCE = WHATS_NEW_SOURCE.replace(/WHATS_NEW_en\.md$/, "WHATS_NEW.md")
const PACKAGE_MANIFEST = resolve(__dirname, "../../../package.json")

function majorMinor(version: string): string {
	return version.split(".").slice(0, 2).join(".")
}

function parse(markdown: string) {
	return parseWhatsNew(markdown, "WHATS_NEW_en.md")
}

describe("parseWhatsNew", () => {
	it("reads only the newest release and keeps its inline runs", () => {
		const release = parse(
			[
				"# What's New",
				"",
				"Intro prose with *emphasis* is ignored.",
				"",
				"<!--",
				"- not an item",
				"-->",
				"",
				"## 1.2.0",
				"",
				"- **Bold lead**: uses `a_tool` and the [docs](https://example.com/docs).",
				"- Plain item that wraps",
				"  onto a second line.",
				"",
				"## 1.1.0",
				"",
				"- Older item.",
			].join("\r\n"),
		)

		expect(release).toEqual({
			version: "1.2.0",
			items: [
				[
					{ kind: "strong", text: "Bold lead" },
					{ kind: "text", text: ": uses " },
					{ kind: "code", text: "a_tool" },
					{ kind: "text", text: " and the " },
					{ kind: "link", text: "docs", href: "https://example.com/docs" },
					{ kind: "text", text: "." },
				],
				[{ kind: "text", text: "Plain item that wraps onto a second line." }],
			],
		})
	})

	it("accepts a byte order mark before the first line", () => {
		expect(parse("\uFEFF## 1.2.0\n- item\n").version).toBe("1.2.0")
	})

	it("rejects a document without a release heading", () => {
		expect(() => parse("# What's New\n\n- item\n")).toThrow('WHATS_NEW_en.md: no release heading such as "## 1.2.3"')
	})

	it.each([
		["## [1.2.0]"],
		["## v1.2.0"],
		["## 1.2.0-beta"],
		["## Format"],
	])("rejects %s as the first section instead of skipping to an older release", (heading) => {
		expect(() => parse(`${heading}\n- new item\n\n## 1.1.0\n- old item\n`)).toThrow(
			`WHATS_NEW_en.md:1: the first "##" heading must be a bare release version such as "## 1.2.3", got "${heading}".`,
		)
	})

	it("rejects an empty release", () => {
		expect(() => parse("## 1.2.0\n\n## 1.1.0\n- item\n")).toThrow("WHATS_NEW_en.md:1: release 1.2.0 has no")
	})

	it("reports the line of content that is not a list item", () => {
		expect(() => parse("## 1.2.0\n\n- item\n\nA paragraph.\n")).toThrow(
			'WHATS_NEW_en.md:5: expected a "- " list item or an indented continuation line, got "A paragraph."',
		)
	})

	it.each([["  - nested"], ["  1. nested"]])("rejects the nested list %s", (line) => {
		expect(() => parse(`## 1.2.0\n- item\n${line}\n`)).toThrow("WHATS_NEW_en.md:3: nested lists are not supported.")
	})

	it.each([
		["unclosed bold", "- **Bold lead: text"],
		["single emphasis", "- an *emphasised* word"],
		["code inside bold", "- **use `code` here**"],
		["link inside bold", "- **see [docs](https://example.com)**"],
		["unclosed code", "- run `npm test"],
		["strikethrough", "- ~~removed~~ feature"],
		["inline HTML", "- a <b>bold</b> claim"],
		["autolink", "- see <https://example.com>"],
		["HTML entity", "- fast &amp; safe"],
	])("rejects %s", (_name, item) => {
		expect(() => parse(`## 1.2.0\n${item}\n`)).toThrow("WHATS_NEW_en.md:2: unsupported inline Markdown")
	})

	it("rejects images", () => {
		expect(() => parse("## 1.2.0\n- ![logo](https://example.com/logo.png)\n")).toThrow(
			'WHATS_NEW_en.md:2: image "logo" is not supported',
		)
	})

	it("rejects links that are not absolute https URLs", () => {
		expect(() => parse("## 1.2.0\n- see [notes](../changelog/CHANGELOG_en.md)\n")).toThrow(
			'WHATS_NEW_en.md:2: link "notes" must use an absolute https:// URL',
		)
	})
})

describe("What's New documents", () => {
	const english = parseWhatsNew(readFileSync(WHATS_NEW_SOURCE, "utf8"), WHATS_NEW_SOURCE)
	const chinese = parseWhatsNew(readFileSync(CHINESE_SOURCE, "utf8"), CHINESE_SOURCE)

	it("ships the release the announcement is shown for", () => {
		// The dialog opens once per major.minor (src/utils/announcements.ts), so the shipped
		// section must describe that line; add a new section when package.json moves to it.
		const manifest = JSON.parse(readFileSync(PACKAGE_MANIFEST, "utf8")) as { version: string }
		expect(majorMinor(english.version)).toBe(majorMinor(manifest.version))
	})

	it("keeps the Chinese edition at the release and item count shipped in the dialog", () => {
		expect(chinese.version).toBe(english.version)
		expect(chinese.items).toHaveLength(english.items.length)
	})

	it("leads every item of both editions with a bold summary", () => {
		for (const item of [...english.items, ...chinese.items]) {
			expect(item[0]?.kind).toBe("strong")
		}
	})
})
