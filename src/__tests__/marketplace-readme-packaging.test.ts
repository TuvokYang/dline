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

async function createFixture(ref: string | undefined) {
    const temporaryRoot = path.join(PROJECT_ROOT, "tmp")
    await fs.mkdir(temporaryRoot, { recursive: true })
    const root = await fs.mkdtemp(path.join(temporaryRoot, "marketplace-readme-"))
    fixtures.add(root)

    for (const relativePath of [
        "README.marketplace.md",
        "marketplace.zh-cn.md",
        "CHANGELOG.md",
        "docs/changelog/CHANGELOG_en.md",
        ".vscodeignore",
        "LICENSE",
        "scripts/marketplace-readme.mjs",
        "scripts/signal-safe-cleanup.mjs",
    ]) {
        const destination = path.join(root, relativePath)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.copyFile(path.join(PROJECT_ROOT, relativePath), destination)
    }

    const project = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"))
    const repositoryUrl = (typeof project.repository === "string" ? project.repository : project.repository.url)
        .replace(/^git\+/, "")
        .replace(/\.git$/, "")
        .replace(/\/$/, "")
    const originalManifest = `${JSON.stringify({
        name: "marketplace-readme-fixture",
        displayName: "Marketplace README fixture",
        description: "Tests version-pinned language links in a packaged README.",
        publisher: "fixture-publisher",
        version: ref?.replace(/^(?:dev-)?v/, "") ?? "0.13.0",
        engines: { vscode: "^1.90.0" },
        repository: { type: "git", url: repositoryUrl },
        license: "Apache-2.0",
        main: "dist/extension.js",
        activationEvents: ["onStartupFinished"],
    })}\n`
    const originalReadme = "# Repository landing page\n\nThis page must be restored after packaging.\n"
    await fs.writeFile(path.join(root, "package.json"), originalManifest)
    await fs.writeFile(path.join(root, "README.md"), originalReadme)
    await fs.mkdir(path.join(root, "dist"), { recursive: true })
    await fs.writeFile(path.join(root, "dist/extension.js"), "exports.activate = () => {};\n")

    return { root, repositoryUrl, originalManifest, originalReadme }
}

afterEach(async () => {
    for (const root of fixtures) {
        await fs.rm(root, { recursive: true, force: true })
        fixtures.delete(root)
    }
})

describe("marketplace language links and images in a VSIX", () => {
    it.each([
        { channel: "production tag", ref: "v0.14.0" },
        { channel: "pre-release tag", ref: "dev-v0.13.0" },
        { channel: "untagged checkout", ref: undefined },
    ])("packages an English listing with a revision-pinned translation for $channel", async ({ ref }) => {
        const { root, repositoryUrl, originalManifest, originalReadme } = await createFixture(ref)
        const expectedRef =
            ref ?? (await execute("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, timeout: 10_000 })).stdout.trim()
        const packagePath = path.join(root, "listing.vsix")
        const readmeModule = pathToFileURL(path.join(root, "scripts/marketplace-readme.mjs")).href
        const packagerModule = pathToFileURL(path.join(PROJECT_ROOT, "scripts/vsix-packager.mjs")).href
        const request = JSON.stringify({ cwd: root, mode: "pack-only", packagePath, preRelease: ref?.startsWith("dev-v") })

        // Use the production swap and VSCE adapter without touching the checkout's
        // README, backup, package identity or shared dist directory.
        await execute(
            process.execPath,
            [
                "--input-type=module",
                "--eval",
                `import { withMarketplaceReadme } from ${JSON.stringify(readmeModule)};
                 import { packageVsix } from ${JSON.stringify(packagerModule)};
                 await withMarketplaceReadme((cleanups) => packageVsix({ ...${request}, cleanups }), ${JSON.stringify(ref ? { ref } : {})})
                     .catch((error) => { console.error(error.message); process.exitCode = 1; });`,
            ],
            { cwd: root, timeout: 30_000, windowsHide: true },
        )

        const entries = await readZip(packagePath, (name) => name.endsWith(".md"))
        const originalChinese = await fs.readFile(path.join(PROJECT_ROOT, "CHANGELOG.md"), "utf8")
        const originalEnglish = await fs.readFile(path.join(PROJECT_ROOT, "docs/changelog/CHANGELOG_en.md"), "utf8")
        const packagedChangelog = entries.get("extension/changelog.md")?.toString("utf8")
        expect(packagedChangelog).toBeDefined()
        expect(load(markdown.render(packagedChangelog ?? "")).text()).toBe(load(markdown.render(originalEnglish)).text())
        expect([...entries.keys()].filter((name) => /(?:^|\/)changelog[^/]*\.md$/i.test(name))).toEqual([
            "extension/changelog.md",
        ])
        expect([...entries.keys()].some((name) => name.startsWith("extension/docs/"))).toBe(false)
        expect(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8")).toBe(originalChinese)
        expect(await fs.readFile(path.join(root, "docs/changelog/CHANGELOG_en.md"), "utf8")).toBe(originalEnglish)
        const readme = entries.get("extension/readme.md")?.toString("utf8")
        expect(readme).toBeDefined()
        const links = [...(readme ?? "").matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g)]
        const languageLink = links.find((link) => link[2] === `${repositoryUrl}/blob/${expectedRef}/marketplace.zh-cn.md`)
        expect(languageLink?.[1]).toBe("中文")
        const englishContent = (readme ?? "").replace(languageLink?.[0] ?? "", "")
        expect(/\p{Script=Han}/u.test(englishContent)).toBe(false)
        expect(entries.has("extension/marketplace.zh-cn.md")).toBe(false)
        expect(entries.has("extension/readme.marketplace.md")).toBe(false)
        expect(entries.has("extension/.readme.github.bak")).toBe(false)

        const source = await fs.readFile(path.join(root, "README.marketplace.md"), "utf8")
        const sourceImages = load(markdown.render(source))("img[src]")
            .toArray()
            .map((image) => image.attribs.src)
        const images = load(markdown.render(readme ?? ""))("img[src]").toArray()
        expect(sourceImages.map((image) => path.posix.extname(image))).toEqual([".gif", ".gif"])
        expect(images).toHaveLength(sourceImages.length)
        for (const [index, image] of images.entries()) {
            const original = new URL(sourceImages[index], "https://repository.invalid/")
            expect(new URL(image.attribs.src)).toMatchObject({
                protocol: "https:",
                hostname: "raw.githubusercontent.com",
                pathname: `${new URL(repositoryUrl).pathname}/${expectedRef}${original.pathname}`,
                search: original.search,
                hash: original.hash,
            })
        }

        expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(originalReadme)
        expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe(originalManifest)
        await expect(fs.access(path.join(root, ".README.github.bak"))).rejects.toMatchObject({ code: "ENOENT" })
    })
})
