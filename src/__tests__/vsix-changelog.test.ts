import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { load } from "cheerio"
import { describe, expect, it } from "vitest"
import { readChangelog } from "../../scripts/changelog.mjs"
// @ts-expect-error -- packaging scripts are plain ESM without type declarations.
import { renderChangelogs, sectionAnchor, UNRELEASED_SECTION } from "../../scripts/vsix-changelog.mjs"

/**
 * The VSIX changelog is generated per language, not copied and not merged: one
 * content section of one language source becomes that language's document for the
 * packaged version.
 *
 * These tests read the *rendered* document rather than its source lines, so a
 * structure a Marketplace reader would not see cannot pass. Headings and links are
 * checked through a real Markdown renderer, and the navigation target must be the
 * maintained source path the repository actually stores.
 */

const require = createRequire(import.meta.url)
const MarkdownIt = require("markdown-it") as new (options: { html: boolean }) => { render(content: string): string }
const markdown = new MarkdownIt({ html: true })

const REPOSITORY = "https://github.com/TuvokYang/Dline"
const REF = "v0.14.1"
const ENGLISH = "docs/changelog/CHANGELOG_en.md"
const CHINESE = "CHANGELOG.md"

/** Fenced samples carry headings that must never become document structure. */
const FENCED_SAMPLE = ["```text", "## Not a released version", "### Also not a category", "const kept = true", "```"]

/** Current notes hold only the selected version, never a version index. */
const ENGLISH_SOURCE = [
    "# Changelog",
    "",
    "## [0.14.0]",
    "",
    "### Added",
    "- Released English addition one.",
    "- Released English addition two.",
    "",
    ...FENCED_SAMPLE,
    "",
    "### Fixed",
    "- Released English fix that links to [the documentation](https://dline.cc/docs).",
].join("\n")

const CHINESE_SOURCE = [
    "# Changelog",
    "",
    "## [0.14.0]",
    "",
    "### Added",
    "- 正式版中文新增条目一。",
    "- 正式版中文新增条目二。",
    "",
    "### Fixed",
    "- 正式版中文修复：保留 `inline code` 与 [文档链接](https://dline.cc/docs/zh)。",
].join("\n")

const RELEASED_ENTRIES = {
    english: [
        "Released English addition one.",
        "Released English addition two.",
        "Released English fix that links to [the documentation](https://dline.cc/docs).",
    ],
    chinese: [
        "正式版中文新增条目一。",
        "正式版中文新增条目二。",
        "正式版中文修复：保留 `inline code` 与 [文档链接](https://dline.cc/docs/zh)。",
    ],
}

/**
 * Navigation lines the packaging owner generates for a ref and content section.
 *
 * @param {string} section Selected content section.
 */
function navigationFor(section: string, source: "current" | "history" = "current") {
    const anchor = sectionAnchor(section)
    const english = source === "history" ? "docs/changelog/history.en.md" : ENGLISH
    const chinese = source === "history" ? "docs/changelog/history.zh-CN.md" : CHINESE
    return {
        english: `English | [中文](${REPOSITORY}/blob/${REF}/${chinese}#${anchor})`,
        chinese: `[English](${REPOSITORY}/blob/${REF}/${english}#${anchor}) | 中文`,
    }
}

const OUTLINE = "h1, h2, h3, h4, h5, h6, a[href]"

type OutlineNode = { level: number; text: string } | { text: string; link: string } | { text: string; target: string }

/**
 * Headings and links of the rendered document, in document order.
 *
 * A page-internal link keeps its decoded fragment so a GFM anchor compares equal; a
 * cross-document link keeps its absolute target, because these documents never link
 * to themselves.
 */
function outlineOf(content: string): OutlineNode[] {
    const document = load(markdown.render(content))
    return document(OUTLINE)
        .toArray()
        .map((element) => {
            const node = document(element)
            const tag = element.tagName.toLowerCase()
            const text = node.text().trim()
            const href = node.attr("href") ?? ""
            if (/^h[1-6]$/.test(tag)) return { level: Number(tag.slice(1)), text }
            return href.startsWith("#") ? { text, link: decodeFragment(href) } : { text, target: href }
        })
}

/** Fragment of a rendered page-internal link, decoded so `#中文` compares equal. */
function decodeFragment(href: string): string {
    const fragment = href.startsWith("#") ? href.slice(1) : href
    try {
        return decodeURIComponent(fragment)
    } catch {
        return fragment
    }
}

/**
 * Render with notes that the shared reader actually produced.
 *
 * The renderer is a pure formatter, so these tests feed it through the same reader
 * a package uses: a temporary root holds both current sources and both notes come
 * back validated, anchored and located.
 *
 * @param {string} section Selected content section.
 * @param {string} displayVersion Packaged manifest version.
 * @param {{ english?: string, chinese?: string, source?: "current"|"history" }} [overrides]
 */
function render(
    section: string,
    displayVersion: string,
    overrides: { english?: string; chinese?: string; source?: "current" | "history" } = {},
) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-changelog-"))
    try {
        if (overrides.source === "history") {
            fs.mkdirSync(path.join(root, "docs", "changelog"), { recursive: true })
            fs.writeFileSync(
                path.join(root, "docs/changelog/history.en.md"),
                ["# Changelog", "", `## [${section}]`, "", overrides.english ?? "- Archived English entry.", ""].join("\n"),
            )
            fs.writeFileSync(
                path.join(root, "docs/changelog/history.zh-CN.md"),
                ["# Changelog", "", `## [${section}]`, "", overrides.chinese ?? "- 归档中文条目。", ""].join("\n"),
            )
            const notes = readChangelog({ root, version: section, source: "history" })
            return renderChangelogs({ section, displayVersion, navigation: navigationFor(section, "history"), notes })
        }
        const current = {
            english: overrides.english ?? ENGLISH_SOURCE,
            chinese: overrides.chinese ?? CHINESE_SOURCE,
        }
        for (const [language, relativePath] of [
            ["english", ENGLISH],
            ["chinese", CHINESE],
        ] as const) {
            fs.mkdirSync(path.join(root, path.dirname(relativePath)), { recursive: true })
            fs.writeFileSync(path.join(root, relativePath), current[language])
        }
        const notes = readChangelog({ root, version: section, source: "current" })
        return renderChangelogs({ section, displayVersion, navigation: navigationFor(section), notes })
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
}

describe("sectionAnchor", () => {
    it.each([
        ["0.14.1", "0141"],
        ["dev-v0.14.1", "dev-v0141"],
        [UNRELEASED_SECTION, "unreleased"],
    ])("renders the GFM anchor of %s as %s", (section, anchor) => {
        expect(sectionAnchor(section)).toBe(anchor)
    })
})

describe("renderChangelogs", () => {
    it("renders one document per language with its own title, navigation and version", () => {
        const { english, chinese } = render("0.14.0", "0.14.0")

        // An exact outline rejects any extra heading: a second version, an
        // `Unreleased` title, a language wrapper, or a demoted category.
        expect(outlineOf(english)).toEqual([
            { level: 1, text: "Changelog" },
            { text: "中文", target: `${REPOSITORY}/blob/${REF}/${CHINESE}#0140` },
            { level: 2, text: "[0.14.0]" },
            { level: 3, text: "Added" },
            { level: 3, text: "Fixed" },
            { text: "the documentation", target: "https://dline.cc/docs" },
        ])
        expect(outlineOf(chinese)).toEqual([
            { level: 1, text: "更新日志" },
            { text: "English", target: `${REPOSITORY}/blob/${REF}/${ENGLISH}#0140` },
            { level: 2, text: "[0.14.0]" },
            { level: 3, text: "Added" },
            { level: 3, text: "Fixed" },
            { text: "文档链接", target: "https://dline.cc/docs/zh" },
        ])
    })

    it("keeps each body in its own language and links the other language source", () => {
        const { english, chinese } = render("0.14.0", "0.14.0")

        for (const entry of RELEASED_ENTRIES.chinese) expect(english).not.toContain(entry)
        for (const entry of RELEASED_ENTRIES.english) expect(chinese).not.toContain(entry)

        // The navigation points at a maintained source that Git stores, at the
        // packaged ref, and never at the generated or ignored output directory.
        expect(english).toContain(`${REPOSITORY}/blob/${REF}/${CHINESE}#0140`)
        expect(chinese).toContain(`${REPOSITORY}/blob/${REF}/${ENGLISH}#0140`)
        for (const document of [english, chinese]) {
            expect(document).not.toContain("dist/docs")
            expect(document).not.toContain("#english")
            expect(document).not.toContain('<a id="')
            // The removed online suffixes never come back.
            expect(document).not.toContain("（在线）")
            expect(document).not.toContain("(online)")
        }
    })

    it("serialises one version per document and never a source title or other section", () => {
        const { english, chinese } = render("0.14.0", "0.14.0")

        for (const document of [english, chinese]) {
            // Counted in the rendering, because the fenced sample legitimately keeps
            // a `## ` line that must not be read as a version.
            expect(outlineOf(document).filter((node) => "level" in node && node.level === 2)).toEqual([
                { level: 2, text: "[0.14.0]" },
            ])
            expect(document).not.toContain("Unreleased")
            expect(document).not.toContain("0.13.0")
            expect(document).not.toContain("### English")
            expect(document).not.toContain("### 中文")
        }

        // The navigation sits above the version so a reader reaches the other
        // language before the notes begin.
        expect(english.indexOf(`blob/${REF}/${CHINESE}`)).toBeLessThan(english.indexOf("## [0.14.0]"))
        expect(chinese.indexOf(`blob/${REF}/${ENGLISH}`)).toBeLessThan(chinese.indexOf("## [0.14.0]"))
    })

    it("keeps every selected entry once, in source order, with its links", () => {
        const { english, chinese } = render("0.14.0", "0.14.0")
        const documents = { english, chinese }

        for (const language of ["english", "chinese"] as const) {
            const positions = RELEASED_ENTRIES[language].map((entry) => documents[language].indexOf(entry))
            expect(positions.every((position) => position >= 0)).toBe(true)
            expect(positions).toEqual([...positions].sort((left, right) => left - right))
            for (const entry of RELEASED_ENTRIES[language]) {
                expect(documents[language].split(entry).length - 1, entry).toBe(1)
            }
        }
        expect(english).toContain("https://dline.cc/docs")
        expect(chinese).toContain("https://dline.cc/docs/zh")
    })

    it("keeps fenced samples intact and continues the section after them", () => {
        const { english } = render("0.14.0", "0.14.0")

        // A fenced `##` is data: it neither ends the section nor becomes a version,
        // and the entries written after it still ship.
        expect(english).toContain(FENCED_SAMPLE.join("\n"))
        expect(english).toContain(RELEASED_ENTRIES.english[2])
        expect(outlineOf(english).some((node) => "text" in node && node.text === "Not a released version")).toBe(false)
        expect(outlineOf(english).some((node) => "text" in node && node.text === "Also not a category")).toBe(false)
    })

    it("displays the packaged version independently of the selected content section", () => {
        const { english, chinese } = render("0.14.0", "0.14.0-devhash")

        for (const document of [english, chinese]) {
            expect(outlineOf(document).filter((node) => "level" in node && node.level === 2)).toEqual([
                { level: 2, text: "[0.14.0-devhash]" },
            ])
        }
        // The content is still the released `0.14.0` section, and the anchor follows
        // the content section rather than the displayed timestamp.
        for (const entry of [...RELEASED_ENTRIES.english, ...RELEASED_ENTRIES.chinese]) {
            expect(`${english}\n${chinese}`).toContain(entry)
        }
        expect(english).toContain(`#0140`)
    })

    it("reads CRLF sources and several fence styles without truncating the section", () => {
        // A tilde fence, a longer backtick fence containing a shorter one, and
        // entries after both must all survive.
        const english = [
            "# Changelog",
            "",
            "## [0.14.0]",
            "",
            "### Added",
            "- Before the tilde fence.",
            "",
            "~~~markdown",
            "## Not a version either",
            "~~~",
            "",
            "### Fixed",
            "- Between the fences.",
            "",
            "````markdown",
            "```text",
            "## Nested heading sample",
            "```",
            "````",
            "",
            "- After every fence.",
        ].join("\r\n")
        const chinese = [
            "# Changelog",
            "",
            "## [0.14.0]",
            "",
            "### Added",
            "- 围栏前的中文条目。",
            "",
            "### Fixed",
            "- 围栏后的中文条目。",
        ].join("\r\n")

        const rendered = render("0.14.0", "0.14.0", { english, chinese })

        expect(rendered.english).toContain(["~~~markdown", "## Not a version either", "~~~"].join("\n"))
        expect(rendered.english).toContain(["````markdown", "```text", "## Nested heading sample", "```", "````"].join("\n"))
        for (const entry of ["Before the tilde fence.", "Between the fences.", "After every fence."]) {
            expect(rendered.english).toContain(entry)
        }
        expect(rendered.english).not.toContain("\r")
        expect(rendered.chinese).not.toContain("\r")
    })

    it("preserves authored marker-like text inside a selected code sample", () => {
        const sample = ["```html", "## Not a version", "<!--dline-vsix-changelog-fence:example-->", "```"].join("\n")
        const source = ENGLISH_SOURCE.replace(FENCED_SAMPLE.join("\n"), sample)

        const { english } = render("0.14.0", "0.14.0", { english: source })
        const document = load(markdown.render(english))

        expect(document("pre code").text()).toBe("## Not a version\n<!--dline-vsix-changelog-fence:example-->\n")
        expect(document("h2").text()).toBe("[0.14.0]")
        expect(english).toContain(RELEASED_ENTRIES.english[2])
    })

    it("does not copy marker-like text from outside the selected body", () => {
        const source = ENGLISH_SOURCE.replace("## [0.14.0]", "<!--dline-vsix-changelog-fence:example-->\n\n## [0.14.0]")

        const { english } = render("0.14.0", "0.14.0", { english: source })

        for (const entry of RELEASED_ENTRIES.english) expect(english).toContain(entry)
        expect(english).not.toContain("<!--dline-vsix-changelog-fence:example-->")
    })

    it("states an empty rolling section in each language instead of borrowing a release", () => {
        const english = "# Changelog\n\n## [Unreleased]\n"
        const chinese = "# Changelog\n\n## [Unreleased]\n"

        const rendered = render(UNRELEASED_SECTION, "0.14.1-abc1234", { english, chinese })

        // Both documents keep their title, navigation and version so the structure
        // stays complete and the two editions stay symmetrical.
        expect(outlineOf(rendered.english)).toEqual([
            { level: 1, text: "Changelog" },
            { text: "中文", target: `${REPOSITORY}/blob/${REF}/${CHINESE}#unreleased` },
            { level: 2, text: "[0.14.1-abc1234]" },
        ])
        expect(outlineOf(rendered.chinese)).toEqual([
            { level: 1, text: "更新日志" },
            { text: "English", target: `${REPOSITORY}/blob/${REF}/${ENGLISH}#unreleased` },
            { level: 2, text: "[0.14.1-abc1234]" },
        ])
        expect(rendered.english).toContain("No changes are recorded for this build yet.")
        expect(rendered.chinese).toContain("此构建尚无已记录的新增变更。")
        expect(rendered.english).not.toContain("此构建尚无已记录的新增变更。")
        expect(rendered.chinese).not.toContain("No changes are recorded for this build yet.")
        for (const entry of [...RELEASED_ENTRIES.english, ...RELEASED_ENTRIES.chinese]) {
            expect(`${rendered.english}\n${rendered.chinese}`).not.toContain(entry)
        }
    })

    it("rejects a request without a content section", () => {
        expect(() => render("", "0.14.0")).toThrow(/version must not be empty/)
        expect(() => renderChangelogs({ section: "", displayVersion: "0.14.0" })).toThrow(/explicit content section/)
    })

    it("rejects a request without the packaged version", () => {
        expect(() => render("0.14.0", "  ")).toThrow(/packaged manifest version/)
    })

    it("rejects a request without a navigation line for every language", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-changelog-nav-"))
        try {
            for (const [language, relativePath] of [
                ["english", ENGLISH],
                ["chinese", CHINESE],
            ] as const) {
                fs.mkdirSync(path.join(root, path.dirname(relativePath)), { recursive: true })
                fs.writeFileSync(path.join(root, relativePath), language === "english" ? ENGLISH_SOURCE : CHINESE_SOURCE)
            }
            const notes = readChangelog({ root, version: "0.14.0" })
            expect(() =>
                renderChangelogs({
                    section: "0.14.0",
                    displayVersion: "0.14.0",
                    navigation: { ...navigationFor("0.14.0"), chinese: "" },
                    notes,
                }),
            ).toThrow(/chinese navigation line/)
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    it("rejects notes that the shared reader did not produce", () => {
        expect(() =>
            renderChangelogs({
                section: "0.14.0",
                displayVersion: "0.14.0",
                navigation: navigationFor("0.14.0"),
                notes: { english: { body: "- x", empty: false } },
            }),
        ).toThrow(/validated notes for both languages/)
    })

    it("renders an archived version from its history snapshot", () => {
        const { english, chinese } = render("0.13.0", "0.13.0", { source: "history" })

        expect(english).toContain("- Archived English entry.")
        expect(chinese).toContain("- 归档中文条目。")
        // The navigation follows the source the reader actually selected.
        expect(english).toContain(`${REPOSITORY}/blob/${REF}/docs/changelog/history.zh-CN.md#0130`)
        expect(chinese).toContain(`${REPOSITORY}/blob/${REF}/docs/changelog/history.en.md#0130`)
        expect(outlineOf(english)).toContainEqual({ level: 2, text: "[0.13.0]" })
    })
})
