import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { load } from "cheerio"
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
const ABSOLUTE_OR_FRAGMENT = /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i
const MarkdownIt = createRequire(import.meta.url)("markdown-it") as new (options: {
    html: boolean
}) => {
    render(content: string): string
}
const markdown = new MarkdownIt({ html: true })

function collectReferences(content: string) {
    const $ = load(markdown.render(content))
    return $("a[href], img[src], source[src], video[src], video[poster]")
        .toArray()
        .flatMap((element) =>
            ["href", "src", "poster"].flatMap((attribute) => {
                const target = $(element).attr(attribute)
                return target === undefined ? [] : [{ attribute, target }]
            }),
        )
}

function collectRepositoryTargets(content: string): string[] {
    return collectReferences(content)
        .map(({ target }) => target)
        .filter((target) => target !== "" && !ABSOLUTE_OR_FRAGMENT.test(target))
}

describe("marketplace README repository links", () => {
    it("pins page links to blob and images to raw at the packaged ref", () => {
        const source = [
            "[中文](README_zh.md) · [Changelog](docs/changelog/CHANGELOG_en.md#094)",
            '<p align="center"><img src="assets/docs/marketplace/r1-hero.gif" width="1200" alt="demo" /></p>',
            "![icon](assets/icons/icon.png)",
            '<a href="LICENSE">license</a>',
        ].join("\n\n")

        const pinned = pinRepositoryLinks(source, REPOSITORY_URL, "dev-v0.9.4")

        const targets = collectReferences(pinned).map(({ target }) => new URL(target))
        expect(targets.map((target) => target.hostname)).toEqual([
            "github.com",
            "github.com",
            "raw.githubusercontent.com",
            "raw.githubusercontent.com",
            "github.com",
        ])
        expect(targets.map((target) => target.pathname)).toEqual([
            "/TuvokYang/Dline/blob/dev-v0.9.4/README_zh.md",
            "/TuvokYang/Dline/blob/dev-v0.9.4/docs/changelog/CHANGELOG_en.md",
            "/TuvokYang/Dline/dev-v0.9.4/assets/docs/marketplace/r1-hero.gif",
            "/TuvokYang/Dline/dev-v0.9.4/assets/icons/icon.png",
            "/TuvokYang/Dline/blob/dev-v0.9.4/LICENSE",
        ])
        expect(targets[1].hash).toBe("#094")
    })

    it.each([
        "v0.13.1",
        "dev-v0.13.1",
        "0123456789abcdef0123456789abcdef01234567",
        "feature/marketplace-media",
    ])("serves Markdown and HTML media directly from GitHub at %s, preserving paths, queries and fragments", (ref) => {
        const source = [
            "![icon](./assets/icons/icon.png?download=1#icon)",
            "![demo](/assets/docs/marketplace/dline-demo.gif?raw=1#demo)",
            "![vector](assets/icons/./icon.svg?theme=dark#vector)",
            '<img src="assets/icons/icon.svg?theme=light#mark" alt="vector" />',
            "<picture><source src='assets/docs/marketplace/r2-quick-start.gif?size=large#animation'></picture>",
            '<video src="assets/docs/marketplace/demo.mp4?autoplay=1#t=1"></video>',
            "<video poster='./assets/icons/icon.png?poster=1#cover'></video>",
        ].join("\n\n")
        const originals = collectReferences(source)
        const references = collectReferences(pinRepositoryLinks(source, REPOSITORY_URL, ref))

        expect(originals).toHaveLength(7)
        expect(references).toHaveLength(originals.length)
        for (const [index, reference] of references.entries()) {
            const original = new URL(originals[index].target, "https://repository.invalid/")
            expect(reference.attribute).toBe(originals[index].attribute)
            expect(new URL(reference.target)).toMatchObject({
                protocol: "https:",
                hostname: "raw.githubusercontent.com",
                pathname: `${new URL(REPOSITORY_URL).pathname}/${ref}${original.pathname}`,
                search: original.search,
                hash: original.hash,
            })
        }
    })

    it.each([
        "https://gitlab.example.com/team/project",
        "https://github.com.example.com/team/project",
    ])("preserves the existing projection for non-GitHub repositories: %s", (repositoryUrl) => {
        const source = "![icon](assets/icons/icon.svg?theme=dark#mark)\n\n[guide](docs/guide.md?lang=en#start)"
        const references = collectReferences(pinRepositoryLinks(source, repositoryUrl, "feature/media"))
        const repository = new URL(repositoryUrl)

        expect(references).toHaveLength(2)
        for (const [index, reference] of references.entries()) {
            const original = new URL(collectReferences(source)[index].target, "https://repository.invalid/")
            expect(new URL(reference.target)).toMatchObject({
                origin: repository.origin,
                pathname: `${repository.pathname}/${reference.attribute === "href" ? "blob" : "raw"}/feature/media${original.pathname}`,
                search: original.search,
                hash: original.hash,
            })
        }
    })

    it("leaves absolute URLs, anchors and fenced code untouched", () => {
        const source = [
            "[Cline](https://github.com/cline/cline) · [docs](https://docs.dline.cc/) · [top](#why-dline)",
            "![icon](https://github.com/TuvokYang/Dline/raw/existing/assets/icons/icon.png?raw=1#mark)",
            "![demo](https://raw.githubusercontent.com/TuvokYang/Dline/existing/assets/demo.gif)",
            '<img src="//github.com/TuvokYang/Dline/raw/existing/assets/icons/icon.svg" />',
            '<video poster="https://example.com/poster.png" src="https://example.com/demo.mp4"></video>',
            "```gitignore",
            "[not a link](secrets/)",
            "![not an image](assets/icons/icon.svg)",
            "```",
            "~~~html",
            '<img src="assets/icons/icon.png" />',
            "~~~",
        ].join("\n")

        expect(pinRepositoryLinks(source, REPOSITORY_URL, "abc123")).toBe(source)
    })

    it.each([
        "[x](../outside.md)",
        "![x](../outside.png?raw=1#mark)",
        "![x](assets/../../outside.gif)",
        '<img src="/../outside.svg" />',
        "<source src='../../outside.gif'>",
        '<video src="../outside.mp4"></video>',
        '<video poster="../outside.png"></video>',
    ])("rejects a repository escape in %s", (source) => {
        expect(() => pinRepositoryLinks(source, REPOSITORY_URL, "abc123")).toThrow(/outside the repository/)
    })

    it("refuses to pin without a repository or a ref", () => {
        expect(() => pinRepositoryLinks("[x](LICENSE)", null, "abc123")).toThrow(/repository URL/)
        expect(() => pinRepositoryLinks("[x](LICENSE)", REPOSITORY_URL, "")).toThrow(/No ref/)
    })

    it("keeps the body English while offering a native-language link to the Chinese edition", async () => {
        const readme = await fs.readFile(path.join(PROJECT_ROOT, "README.marketplace.md"), "utf8")
        const languageLink = readme.match(/\[([^\]]+)\]\(marketplace\.zh-cn\.md\)/)

        expect(languageLink?.[1]).toBe("中文")
        const englishContent = readme.replace(languageLink?.[0] ?? "", "")
        expect(/\p{Script=Han}/u.test(englishContent), "the listing body must remain English").toBe(false)
        expect(collectRepositoryTargets(readme)).toContain("marketplace.zh-cn.md")
        expect(collectRepositoryTargets(readme)).not.toContain("README_zh.md")
    })

    it("lets the Chinese edition return to the English listing at the same GitHub revision", async () => {
        const readme = await fs.readFile(path.join(PROJECT_ROOT, "marketplace.zh-cn.md"), "utf8")

        expect(/\p{Script=Han}/u.test(readme)).toBe(true)
        const base = `${REPOSITORY_URL}/blob/0123456789abcdef0123456789abcdef01234567/marketplace.zh-cn.md`
        const resolvedPaths = collectRepositoryTargets(readme).map((target) => new URL(target, base).pathname)
        expect(resolvedPaths).toContain("/TuvokYang/Dline/blob/0123456789abcdef0123456789abcdef01234567/README.marketplace.md")
    })

    it.each([
        "README.marketplace.md",
        "marketplace.zh-cn.md",
    ])("keeps %s within 500 text lines, excluding standalone media", async (edition) => {
        const readme = await fs.readFile(path.join(PROJECT_ROOT, edition), "utf8")
        const standaloneMedia = /^\s*(?:<(?:img|video)\b[^>]*>.*|<p\b[^>]*>\s*<(?:img|video)\b.*<\/p>|!\[[^\]]*\]\([^)]+\))\s*$/i
        const textLines = readme
            .trimEnd()
            .split(/\r?\n/)
            .filter((line) => !standaloneMedia.test(line))

        expect(textLines.length, `${edition} must fit the Marketplace text budget`).toBeLessThanOrEqual(500)
    })

    it("links both editions to the same user documentation in their respective languages", async () => {
        const documentationPaths: string[][] = []
        for (const [edition, locale] of [
            ["README.marketplace.md", ""],
            ["marketplace.zh-cn.md", "zh-cn/"],
        ]) {
            const readme = await fs.readFile(path.join(PROJECT_ROOT, edition), "utf8")
            const targets = [...readme.matchAll(/\]\(https:\/\/docs\.dline\.cc\/([^\s)]*)\)/g)].map((match) => match[1])
            expect(targets.length).toBeGreaterThan(0)
            const paths: string[] = []
            for (const target of targets) {
                const page = target.split(/[?#]/)[0]
                expect(page.startsWith("zh-cn/")).toBe(locale !== "")
                const relativePage = page.slice(locale.length)
                const slug = relativePage.replace(/\/$/, "") || "index"
                await expect(
                    fs.access(path.join(PROJECT_ROOT, "docs/src/content/docs", locale, `${slug}.mdx`)),
                ).resolves.toBeUndefined()
                paths.push(relativePage)
            }
            documentationPaths.push(paths)
        }
        expect(documentationPaths[1]).toEqual(documentationPaths[0])
    })

    it.each([
        "v0.14.0",
        "dev-v0.13.0",
        "0123456789abcdef0123456789abcdef01234567",
    ])("pins both marketplace editions to existing repository files at %s", async (ref) => {
        const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"))
        const declaredUrl = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
        expect(declaredUrl, "package.json must declare a repository URL").toBeTruthy()
        const repositoryUrl = declaredUrl.replace(/^git\+/, "").replace(/\.git$/, "")
        const repository = new URL(repositoryUrl)

        for (const edition of ["README.marketplace.md", "marketplace.zh-cn.md"]) {
            const readme = await fs.readFile(path.join(PROJECT_ROOT, edition), "utf8")
            expect(readme).not.toMatch(/\/(?:blob|raw|tree)\/(?:main|dev|HEAD)\//)
            const repositoryTargets = collectRepositoryTargets(readme)
            expect(repositoryTargets.length).toBeGreaterThan(0)

            const pinned = pinRepositoryLinks(readme, repositoryUrl, ref)
            expect(collectRepositoryTargets(pinned)).toEqual([])
            const originals = collectReferences(readme)
            const references = collectReferences(pinned)
            expect(references).toHaveLength(originals.length)
            for (const [index, reference] of references.entries()) {
                const original = originals[index]
                expect(reference.attribute).toBe(original.attribute)
                if (ABSOLUTE_OR_FRAGMENT.test(original.target)) {
                    expect(reference.target).toBe(original.target)
                    continue
                }
                const target = new URL(original.target, "https://repository.invalid/")
                const isPage = original.attribute === "href"
                expect(new URL(reference.target)).toMatchObject({
                    protocol: repository.protocol,
                    hostname: isPage ? repository.hostname : "raw.githubusercontent.com",
                    pathname: `${repository.pathname}/${isPage ? `blob/${ref}` : ref}${target.pathname}`,
                    search: target.search,
                    hash: target.hash,
                })
                await expect(
                    fs.access(path.join(PROJECT_ROOT, target.pathname.slice(1))),
                    `${edition}: ${target.pathname} must exist in the repository`,
                ).resolves.toBeUndefined()
            }
        }
    })
})
