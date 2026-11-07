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
const ABSOLUTE_OR_FRAGMENT = /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i

function collectRepositoryTargets(content: string): string[] {
    let inFence = false
    const targets: string[] = []

    for (const line of content.split("\n")) {
        if (/^\s*(?:```|~~~)/.test(line)) {
            inFence = !inFence
            continue
        }
        if (inFence) continue

        for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
            targets.push(match[1])
        }
        for (const match of line.matchAll(/<(?:a|img|source|video)\b[^>]*?\s(?:href|src|poster)=["']([^"']+)["']/gi)) {
            targets.push(match[1])
        }
    }

    return targets.filter((target) => target !== "" && !ABSOLUTE_OR_FRAGMENT.test(target))
}

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
        const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

        for (const edition of ["README.marketplace.md", "marketplace.zh-cn.md"]) {
            const readme = await fs.readFile(path.join(PROJECT_ROOT, edition), "utf8")
            expect(readme).not.toMatch(/\/(?:blob|raw|tree)\/(?:main|dev|HEAD)\//)
            const repositoryTargets = collectRepositoryTargets(readme)
            expect(repositoryTargets.length).toBeGreaterThan(0)

            const pinned = pinRepositoryLinks(readme, repositoryUrl, ref)
            expect(collectRepositoryTargets(pinned)).toEqual([])
            const pattern = new RegExp(`${escapeRegex(repositoryUrl)}/(?:blob|raw)/${escapeRegex(ref)}/([^)"'#?\\s]+)`, "g")
            const targets = [...pinned.matchAll(pattern)].map((match) => match[1])
            expect(targets).toEqual(repositoryTargets)
            for (const target of targets) {
                await expect(
                    fs.access(path.join(PROJECT_ROOT, target)),
                    `${edition}: ${target} must exist in the repository`,
                ).resolves.toBeUndefined()
            }
        }
    })
})
