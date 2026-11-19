import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { load } from "cheerio"
import { afterEach, describe, expect, it } from "vitest"

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
const MarkdownIt = require("markdown-it") as new (options: { html: boolean }) => { render(content: string): string }
const markdown = new MarkdownIt({ html: true })
const { readZip } = require("@vscode/vsce/out/zip.js") as {
    readZip(packagePath: string, filter: (name: string) => boolean): Promise<Map<string, Buffer>>
}

const PROJECT_ROOT = process.cwd()
const fixtures = new Set<string>()

const CHANGELOG_NAME = /changelog[^/]*\.md$/
const CHANGELOG_ASSET = "Microsoft.VisualStudio.Services.Content.Changelog"
const DETAILS_ASSET = "Microsoft.VisualStudio.Services.Content.Details"

/** The two maintained current sources, per language. */
const CHANGELOG_SOURCES = {
    en: "docs/changelog/CHANGELOG_en.md",
    zh: "CHANGELOG.md",
}

/** The four generated documents, as archived names (VSCE lowercases them). */
const DOCUMENT_PATHS = [
    "extension/readme.md",
    "extension/changelog.md",
    "extension/dist/docs/readme.zh-cn.md",
    "extension/dist/docs/changelog.zh-cn.md",
]

/**
 * Paths that must never be archived: the English generated copies VSCE renames
 * into the two official assets, the maintained sources, the compatibility indexes,
 * the older single-note output and a foreign file that only exists on disk.
 */
const ABSENT_PATHS = [
    "extension/dist/docs/readme.en.md",
    "extension/dist/docs/changelog.en.md",
    "extension/readme.marketplace.md",
    "extension/marketplace.zh-cn.md",
    "extension/changelog.vsix.md",
    "extension/dist/changelog.vsix.md",
    "extension/dist/docs/foreign.md",
]

type Language = "en" | "zh"

/** A category with its entries, or a fenced sample that must survive verbatim. */
type Block =
    | { readonly kind: "category"; readonly heading: string; readonly entries: readonly string[] }
    | { readonly kind: "fence"; readonly lines: readonly string[] }

/**
 * Small standalone bilingual notes: a rolling section, the released candidate and
 * one section that only exists in another fixture's current file.
 *
 * Every entry is unique, so each packaged document is checked by presence, order
 * and absence instead of being compared to a copy of repository history. The fenced
 * blocks hold `##` lines that must never be parsed as headings.
 */
const SECTIONS: Record<string, Record<Language, readonly Block[]>> = {
    Unreleased: {
        en: [
            {
                kind: "category",
                heading: "Added",
                entries: ["Rolling English addition that only an untagged development build may show."],
            },
        ],
        zh: [{ kind: "category", heading: "Added", entries: ["仅未标记的开发构建才会显示的中文滚动新增条目。"] }],
    },
    "0.14.0": {
        en: [
            {
                kind: "category",
                heading: "Added",
                entries: ["Released English addition one.", "Released English addition two."],
            },
            {
                kind: "fence",
                lines: ["## Not a released version", "### Also not a category", "const kept = true"],
            },
            {
                kind: "category",
                heading: "Fixed",
                entries: ["Released English fix that links to [the documentation](https://dline.cc/docs)."],
            },
        ],
        zh: [
            { kind: "category", heading: "Added", entries: ["正式版中文新增条目一。", "正式版中文新增条目二。"] },
            {
                kind: "category",
                heading: "Fixed",
                entries: ["正式版中文修复：保留 `inline code` 与 [文档链接](https://dline.cc/docs/zh)。"],
            },
        ],
    },
    "0.13.0": {
        en: [
            {
                kind: "category",
                heading: "Added",
                entries: ["Older English addition that a newer package must not ship."],
            },
            { kind: "fence", lines: ["## Not a historical version", "older-fence-line"] },
            {
                kind: "category",
                heading: "Fixed",
                entries: ["Older English fix that must stay in its own section."],
            },
        ],
        zh: [{ kind: "category", heading: "Added", entries: ["旧版中文新增条目，不得出现在新构建中。"] }],
    },
}

const DOCUMENT_TITLES: Record<Language, string> = { en: "Changelog", zh: "更新日志" }

/** Language labels of the navigation line: the current language, and the other one. */
const LANGUAGE_LABELS: Record<Language, string> = { en: "English", zh: "中文" }

function renderBlock(block: Block): string {
    if (block.kind === "fence") return ["```text", ...block.lines, "```"].join("\n")
    return [`### ${block.heading}`, ...block.entries.map((entry) => `- ${entry}`)].join("\n")
}

/**
 * Current notes of one language contain exactly the selected section.
 * Other versions live only in history and cannot leak into the current package.
 */
function renderSource(language: Language, section: string): string {
    const versions = [section]
    const sections = versions.map((version) => [`## [${version}]`, ...SECTIONS[version][language].map(renderBlock)].join("\n\n"))
    return `${["# Changelog", ...sections].join("\n\n")}\n`
}

function entriesOf(blocks: readonly Block[]): string[] {
    return blocks.flatMap((block) => (block.kind === "category" ? [...block.entries] : []))
}

/** Headings of the rendered document, in document order. */
function headingsOf(content: string): { level: number; text: string }[] {
    const document = load(markdown.render(content))
    return document("h1, h2, h3, h4, h5, h6")
        .toArray()
        .map((element) => ({
            level: Number(element.tagName.toLowerCase().slice(1)),
            text: document(element).text().trim(),
        }))
}

/** Links of the rendered document, in document order. */
function linksOf(content: string): { text: string; target: string }[] {
    const document = load(markdown.render(content))
    return document("a[href]")
        .toArray()
        .map((element) => ({ text: document(element).text().trim(), target: document(element).attr("href") ?? "" }))
}

/** GFM anchor GitHub derives from a content section heading. */
function sectionAnchor(section: string): string {
    return section
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .replace(/\s+/g, "-")
}

async function createFixture(options: { version: string; section?: string }) {
    const section = options.section ?? "0.14.0"
    const temporaryRoot = path.join(PROJECT_ROOT, "tmp")
    await fs.mkdir(temporaryRoot, { recursive: true })
    const root = await fs.mkdtemp(path.join(temporaryRoot, "package-docs-"))
    fixtures.add(root)

    // The shared adapter and its document/text modules are imported from the
    // checkout, so the fixture exercises the real implementation; only the packaged
    // sources and the collection rules belong to the fixture.
    for (const relativePath of ["README.marketplace.md", "marketplace.zh-cn.md", ".vscodeignore", "LICENSE"]) {
        const destination = path.join(root, relativePath)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.copyFile(path.join(PROJECT_ROOT, relativePath), destination)
    }

    // The four generated documents come from four read-only sources: the two
    // listing editions and one current notes file per language. They must come back
    // byte-identical on every path.
    const originalSources = { zh: renderSource("zh", section), en: renderSource("en", section) }
    await fs.mkdir(path.join(root, "docs", "changelog"), { recursive: true })
    await fs.writeFile(path.join(root, CHANGELOG_SOURCES.zh), originalSources.zh)
    await fs.writeFile(path.join(root, CHANGELOG_SOURCES.en), originalSources.en)

    const project = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"))
    const repositoryUrl = (typeof project.repository === "string" ? project.repository : project.repository.url)
        .replace(/^git\+/, "")
        .replace(/\.git$/, "")
        .replace(/\/$/, "")
    const originalManifest = `${JSON.stringify({
        name: "package-docs-fixture",
        displayName: "Packaged documents fixture",
        description: "Tests four language-split packaged documents and their pinned online links.",
        publisher: "fixture-publisher",
        version: options.version,
        engines: { vscode: "^1.90.0" },
        repository: { type: "git", url: repositoryUrl },
        license: "Apache-2.0",
        main: "dist/extension.js",
        activationEvents: ["onStartupFinished"],
    })}\n`
    const originalReadme = "# Repository landing page\n\nThis page must never ship in the VSIX.\n"
    await fs.writeFile(path.join(root, "package.json"), originalManifest)
    await fs.writeFile(path.join(root, "README.md"), originalReadme)
    await fs.mkdir(path.join(root, "dist"), { recursive: true })
    await fs.writeFile(path.join(root, "dist/extension.js"), "exports.activate = () => {};\n")

    // Output another run or an older packaging path may have left behind. Both must
    // stay on disk untouched and must not be collected into the VSIX.
    await fs.mkdir(path.join(root, "dist", "docs"), { recursive: true })
    const stale = {
        legacy: "# Older single-note output this package must not ship\n",
        foreign: "# A file this package does not own\n",
    }
    await fs.writeFile(path.join(root, "dist", "CHANGELOG.vsix.md"), stale.legacy)
    await fs.writeFile(path.join(root, "dist", "docs", "foreign.md"), stale.foreign)

    return { root, repositoryUrl, originalManifest, originalReadme, originalSources, stale }
}

afterEach(async () => {
    for (const root of fixtures) {
        await fs.rm(root, { recursive: true, force: true })
        fixtures.delete(root)
    }
})

describe("packaged README and changelog documents in a VSIX", () => {
    // Both packaging modes must produce the same four documents, so the production
    // case uses VSCE's full entry and the rolling cases the pack-only entry of the
    // shared adapter.
    for (const { channel, mode, ref, version, section, preRelease, selector } of [
        {
            channel: "production tag",
            mode: "build-and-pack",
            ref: "v0.14.0",
            version: "0.14.0",
            section: "0.14.0",
            preRelease: false,
        },
        {
            channel: "pre-release tag",
            mode: "pack-only",
            ref: "dev-v0.13.0",
            version: "0.13.0",
            section: "0.13.0",
            preRelease: true,
        },
        {
            channel: "untagged dev build",
            mode: "pack-only",
            ref: undefined,
            version: "0.15.1731000000",
            section: "Unreleased",
            preRelease: false,
        },
        {
            channel: "development build of a tagged commit",
            mode: "pack-only",
            ref: undefined,
            version: "0.14.0-devhash",
            section: "0.14.0",
            preRelease: false,
        },
        {
            channel: "CI and E2E current selector",
            mode: "pack-only",
            ref: undefined,
            version: "0.14.0",
            section: "Unreleased",
            selector: "current",
            preRelease: false,
        },
    ]) {
        it(`packages four language-split documents with pinned links for ${channel}`, async () => {
            const { root, repositoryUrl, originalManifest, originalReadme, originalSources, stale } = await createFixture({
                version,
                section,
            })
            const expectedRef =
                ref ?? (await execute("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, timeout: 10_000 })).stdout.trim()
            const packagePath = path.join(root, "listing.vsix")
            const packagerModule = pathToFileURL(path.join(PROJECT_ROOT, "scripts", "vsix-packager.mjs")).href
            const request = JSON.stringify({
                cwd: root,
                mode,
                packagePath,
                preRelease,
                // Entries choose the content section and the ref; the adapter renders
                // the section it is told to use and never derives either itself.
                changelogSection: selector ?? section,
                documentationRef: expectedRef,
            })

            // Enter the shared adapter directly: local packaging no longer swaps the
            // repository landing page, so nothing outside the fixture is touched.
            await execute(
                process.execPath,
                [
                    "--input-type=module",
                    "--eval",
                    `import { packageVsix } from ${JSON.stringify(packagerModule)};
                     await packageVsix(${request})
                         .catch((error) => { console.error(error.message); process.exitCode = 1; });`,
                ],
                { cwd: root, timeout: 30_000, windowsHide: true },
            )

            // Read every entry: the filter sees each archived name (lowercased by
            // VSCE) before the Map drops duplicates, so the collected names prove
            // both uniqueness and absence instead of hiding a stray file.
            const entryNames: string[] = []
            const entries = await readZip(packagePath, (name) => {
                entryNames.push(name)
                return true
            })

            // Two official English assets plus two ordinary Chinese files, and
            // nothing else from the documentation sources or an older output.
            expect(entryNames.filter((name) => DOCUMENT_PATHS.includes(name)).sort()).toEqual([...DOCUMENT_PATHS].sort())
            expect(entryNames.filter((name) => ABSENT_PATHS.includes(name))).toEqual([])
            expect(entryNames.filter((name) => CHANGELOG_NAME.test(name)).sort()).toEqual([
                "extension/changelog.md",
                "extension/dist/docs/changelog.zh-cn.md",
            ])
            expect(entryNames.filter((name) => name.startsWith("extension/docs/") || name.endsWith(".vsix.md"))).toEqual([])
            // No maintenance source and no compatibility index ships.
            for (const name of entryNames) expect(name).not.toMatch(/changelog\/(current|history)\//i)
            expect(entryNames.filter((name) => name === "extension.vsixmanifest")).toHaveLength(1)

            const englishNotes = entries.get("extension/changelog.md")?.toString("utf8") ?? ""
            const chineseNotes = entries.get("extension/dist/docs/changelog.zh-cn.md")?.toString("utf8") ?? ""
            const englishReadme = entries.get("extension/readme.md")?.toString("utf8") ?? ""
            const chineseReadme = entries.get("extension/dist/docs/readme.zh-cn.md")?.toString("utf8") ?? ""
            const manifestXml = entries.get("extension.vsixmanifest")?.toString("utf8") ?? ""
            const packagedManifest = JSON.parse(entries.get("extension/package.json")?.toString("utf8") ?? "{}")

            // The displayed version is the packaged manifest version; it is asserted
            // separately from the content section chosen above.
            expect(/<Identity\b[^>]*?\sVersion="([^"]*)"/.exec(manifestXml)?.[1]).toBe(version)
            expect(/\bPublisher="([^"]*)"/.exec(manifestXml)?.[1]).toBe("fixture-publisher")
            expect(packagedManifest.version).toBe(version)
            expect(manifestXml.includes('Id="Microsoft.VisualStudio.Code.PreRelease"')).toBe(preRelease)

            // The two official assets are exactly the English documents.
            const assets = [...manifestXml.matchAll(/<Asset\s+Type="([^"]*)"\s+Path="([^"]*)"/g)].map((asset) => ({
                type: asset[1],
                path: asset[2],
            }))
            expect(assets.filter((asset) => asset.type === CHANGELOG_ASSET)).toEqual([
                { type: CHANGELOG_ASSET, path: "extension/changelog.md" },
            ])
            expect(assets.filter((asset) => asset.type === DETAILS_ASSET)).toEqual([
                { type: DETAILS_ASSET, path: "extension/readme.md" },
            ])

            const blocks = SECTIONS[section]
            if (!blocks) throw new Error(`Fixture has no changelog section '${section}'.`)

            // Each document is one language only: its own title, one navigation line
            // to the other language's current source, one version, then the authored
            // categories at their own level.
            const anchor = sectionAnchor(section)
            const expectedCategories = (language: Language) =>
                blocks[language].flatMap((block) => (block.kind === "category" ? [{ level: 3, text: block.heading }] : []))
            expect(headingsOf(englishNotes)).toEqual([
                { level: 1, text: DOCUMENT_TITLES.en },
                { level: 2, text: `[${version}]` },
                ...expectedCategories("en"),
            ])
            expect(headingsOf(chineseNotes)).toEqual([
                { level: 1, text: DOCUMENT_TITLES.zh },
                { level: 2, text: `[${version}]` },
                ...expectedCategories("zh"),
            ])

            // The navigation is the online cross-reference in each document, and it
            // points at the other language's maintained current source at the packaged
            // ref, anchored on the content section rather than the displayed version.
            // It comes first, followed by the selected section's own links and nothing
            // else. The removed "online" suffixes never reappear.
            const currentSource = (language: Language) => CHANGELOG_SOURCES[language]
            const historyLink = (language: Language) =>
                `${repositoryUrl}/blob/${expectedRef}/${currentSource(language === "en" ? "zh" : "en")}#${anchor}`
            const entryLinks = (language: Language) =>
                entriesOf(blocks[language]).flatMap((entry) =>
                    [...entry.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g)].map((link) => ({
                        text: link[1],
                        target: link[2],
                    })),
                )
            expect(linksOf(englishNotes)).toEqual([{ text: LANGUAGE_LABELS.zh, target: historyLink("en") }, ...entryLinks("en")])
            expect(linksOf(chineseNotes)).toEqual([{ text: LANGUAGE_LABELS.en, target: historyLink("zh") }, ...entryLinks("zh")])
            for (const document of [englishNotes, chineseNotes]) {
                expect(document).not.toContain("（在线）")
                expect(document).not.toContain("(online)")
            }

            // Each document carries its own language entries once, in source order,
            // and none of the other language's or another section's entries.
            for (const [language, document] of [
                ["en", englishNotes],
                ["zh", chineseNotes],
            ] as const) {
                const positions = entriesOf(blocks[language]).map((entry) => document.indexOf(entry))
                expect(positions.every((position) => position >= 0)).toBe(true)
                expect(positions).toEqual([...positions].sort((left, right) => left - right))
                for (const entry of entriesOf(blocks[language])) {
                    expect(document.split(entry).length - 1, entry).toBe(1)
                }
            }
            for (const [other, otherBlocks] of Object.entries(SECTIONS)) {
                if (other === section) continue
                // Only the rolling section of the other fixture participates: the others
                // have no current section in this package's sources.
                for (const entry of [...entriesOf(otherBlocks.en), ...entriesOf(otherBlocks.zh)]) {
                    if (other !== "Unreleased") continue
                    expect(`${englishNotes}\n${chineseNotes}`, other).not.toContain(entry)
                }
            }
            for (const chineseEntry of entriesOf(blocks.zh)) expect(englishNotes).not.toContain(chineseEntry)
            for (const englishEntry of entriesOf(blocks.en)) expect(chineseNotes).not.toContain(englishEntry)

            // No in-page language anchor and no bilingual wrapper heading survives
            // into either generated document.
            for (const document of [englishNotes, chineseNotes]) {
                expect(document).not.toContain('<a id="')
                expect(document).not.toContain("dist/docs")
            }

            // A fenced `##` line inside the selected section is data, not a heading,
            // and the entries after the fence must survive.
            for (const block of [...blocks.en, ...blocks.zh]) {
                if (block.kind !== "fence") continue
                expect(`${englishNotes}\n${chineseNotes}`).toContain(["```text", ...block.lines, "```"].join("\n"))
            }
            expect(headingsOf(englishNotes).some((heading) => heading.text === "Not a released version")).toBe(false)

            // Both README editions keep their own language and link to each other at
            // the packaged ref instead of the repository's default branch.
            expect(linksOf(englishReadme)).toEqual(
                expect.arrayContaining([{ text: "中文", target: `${repositoryUrl}/blob/${expectedRef}/marketplace.zh-cn.md` }]),
            )
            expect(linksOf(chineseReadme)).toEqual(
                expect.arrayContaining([
                    { text: "English", target: `${repositoryUrl}/blob/${expectedRef}/README.marketplace.md` },
                ]),
            )
            // Each edition keeps its own language: the Chinese page is Chinese, and
            // the English page's only Chinese text is the link label to the Chinese
            // edition, which is what a language switch looks like on the listing.
            const chineseBody = chineseReadme.replace(/\[English\]\([^)]*README\.marketplace\.md\)/, "")
            expect(/\p{Script=Han}/u.test(chineseBody)).toBe(true)
            const englishBody = englishReadme.replace(/\[中文\]\([^)]*marketplace\.zh-cn\.md\)/, "")
            expect(/\p{Script=Han}/u.test(englishBody)).toBe(false)

            // Images resolve to the raw endpoint at the packaged ref, so a preview or
            // Insiders build never renders a demo from another revision.
            const sourceImages = load(markdown.render(await fs.readFile(path.join(root, "README.marketplace.md"), "utf8")))(
                "img[src]",
            )
                .toArray()
                .map((image) => image.attribs.src)
            const images = load(markdown.render(englishReadme))("img[src]")
                .toArray()
                .map((image) => image.attribs.src)
            expect(sourceImages.map((image) => path.posix.extname(image))).toEqual([".gif", ".gif"])
            expect(images).toHaveLength(sourceImages.length)
            for (const [index, image] of images.entries()) {
                const original = new URL(sourceImages[index], "https://repository.invalid/")
                expect(new URL(image)).toMatchObject({
                    protocol: "https:",
                    hostname: "raw.githubusercontent.com",
                    pathname: `${new URL(repositoryUrl).pathname}/${expectedRef}${original.pathname}`,
                    search: original.search,
                    hash: original.hash,
                })
            }

            // Sources, the repository landing page and the manifest keep their bytes;
            // the generated documents are released after packing, while pre-existing
            // output and a foreign file stay on disk untouched.
            expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(originalReadme)
            expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe(originalManifest)
            expect(await fs.readFile(path.join(root, CHANGELOG_SOURCES.zh), "utf8")).toBe(originalSources.zh)
            expect(await fs.readFile(path.join(root, CHANGELOG_SOURCES.en), "utf8")).toBe(originalSources.en)
            expect(await fs.readFile(path.join(root, "README.marketplace.md"), "utf8")).toBe(
                await fs.readFile(path.join(PROJECT_ROOT, "README.marketplace.md"), "utf8"),
            )
            expect(await fs.readFile(path.join(root, "marketplace.zh-cn.md"), "utf8")).toBe(
                await fs.readFile(path.join(PROJECT_ROOT, "marketplace.zh-cn.md"), "utf8"),
            )
            await expect(fs.access(path.join(root, ".README.github.bak"))).rejects.toMatchObject({ code: "ENOENT" })
            for (const document of ["README.en.md", "README.zh-CN.md", "CHANGELOG.en.md", "CHANGELOG.zh-CN.md"]) {
                await expect(fs.access(path.join(root, "dist", "docs", document))).rejects.toMatchObject({ code: "ENOENT" })
            }
            expect(await fs.readFile(path.join(root, "dist", "CHANGELOG.vsix.md"), "utf8")).toBe(stale.legacy)
            expect(await fs.readFile(path.join(root, "dist", "docs", "foreign.md"), "utf8")).toBe(stale.foreign)
        })
    }

    it("keeps VSCE's default README available to the legacy swap caller", async () => {
        const { root, originalReadme } = await createFixture({ version: "0.14.0", section: "0.14.0" })
        for (const file of ["marketplace-readme.mjs", "signal-safe-cleanup.mjs"]) {
            const destination = path.join(root, "scripts", file)
            await fs.mkdir(path.dirname(destination), { recursive: true })
            await fs.copyFile(path.join(PROJECT_ROOT, "scripts", file), destination)
        }
        const legacyModule = pathToFileURL(path.join(root, "scripts/marketplace-readme.mjs")).href
        const vsceModule = require.resolve("@vscode/vsce/out/package.js")
        const packagePath = path.join(root, "legacy.vsix")
        await execute(
            process.execPath,
            [
                "--input-type=module",
                "--eval",
                `import { createRequire } from "node:module";
                 import { withMarketplaceReadme } from ${JSON.stringify(legacyModule)};
                 const { pack } = createRequire(import.meta.url)(${JSON.stringify(vsceModule)});
                 await withMarketplaceReadme(() => pack(${JSON.stringify({ cwd: root, packagePath, dependencies: false })}),
                     { ref: "v0.14.0" });`,
            ],
            { cwd: root, timeout: 30_000, windowsHide: true },
        )
        const entries = await readZip(packagePath, (name) => ["extension/readme.md", "extension.vsixmanifest"].includes(name))
        const listing = load(markdown.render(entries.get("extension/readme.md")?.toString("utf8") ?? ""))
        expect(listing("h1").text()).toBe("Dline")
        expect(
            listing("a")
                .toArray()
                .some((node) => listing(node).attr("href")?.includes("/blob/v0.14.0/marketplace.zh-cn.md")),
        ).toBe(true)
        const manifest = load(entries.get("extension.vsixmanifest")?.toString("utf8") ?? "", { xmlMode: true })
        const details = manifest('Asset[Type="Microsoft.VisualStudio.Services.Content.Details"]')
        expect(details).toHaveLength(1)
        expect(details.attr("Path")).toBe("extension/readme.md")
        expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(originalReadme)
        await expect(fs.access(path.join(root, ".README.github.bak"))).rejects.toMatchObject({ code: "ENOENT" })
    })
})
