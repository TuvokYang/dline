import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { createDistributionManifest } from "../extension-manifest-identity.mjs"
import { PACKAGE_DOCUMENTS, withPackageDocs } from "../package-docs.mjs"
import { withSignalSafeCleanup } from "../signal-safe-cleanup.mjs"
import { UNRELEASED_SECTION } from "../vsix-changelog.mjs"

const require = createRequire(import.meta.url)
const { ChangelogProcessor, ReadmeProcessor } = require("@vscode/vsce/out/package.js")
const MarkdownIt = require("markdown-it")
const { load } = require("cheerio")
const markdown = new MarkdownIt({ html: true })

// The document owner generates four files per packaging call from read-only
// sources: the two listing editions and the two current changelog languages. These
// tests exercise the real lifecycle owner (`withSignalSafeCleanup`) through a
// virtual file system, so every path is observed rather than inferred: no write
// happens before all four texts validate, the sources and the repository landing
// page keep their exact bytes during and after the work, and only the files this
// call produced are released.
const root = path.resolve("tmp/virtual-package-docs")
const chineseChangelogPath = path.join(root, "CHANGELOG.md")
const englishChangelogPath = path.join(root, "docs", "changelog", "CHANGELOG_en.md")
const englishReadmePath = path.join(root, "README.marketplace.md")
const chineseReadmePath = path.join(root, "marketplace.zh-cn.md")
const readmePagePath = path.join(root, "README.md")
const outputPaths = Object.fromEntries(
    Object.entries({
        readmeEnglish: "dist/docs/README.en.md",
        readmeChinese: "dist/docs/README.zh-CN.md",
        changelogEnglish: "dist/docs/CHANGELOG.en.md",
        changelogChinese: "dist/docs/CHANGELOG.zh-CN.md",
    }).map(([name, relativePath]) => [name, path.join(root, relativePath)]),
)

const chineseChangelog = Buffer.from("\uFEFF# Changelog\r\n\r\n## [1.2.0]\r\n\r\n### Fixed\r\n- 修复商店说明。\r\n")
const englishChangelog = Buffer.from("# Changelog\n\n## [1.2.0]\n\n### Fixed\n- Fix marketplace documentation.\n")
const englishReadme = Buffer.from(
    "# Fixture\n\n**English · [中文](marketplace.zh-cn.md)**\n\n[Changelog](docs/changelog/CHANGELOG_en.md) | [License](LICENSE)\n",
)
const chineseReadme = Buffer.from("# 示例\n\n**[English](README.marketplace.md) · 中文**\n\n[更新](CHANGELOG.md)\n")
const readmePage = Buffer.from("# Repository landing page\n\nThis page is never swapped by local packaging entries.\n")

const REPOSITORY = "https://github.com/TuvokYang/Dline"
const REF = "v1.2.0"

function fixture() {
    const files = new Map([
        [chineseChangelogPath, Buffer.from(chineseChangelog)],
        [englishChangelogPath, Buffer.from(englishChangelog)],
        [englishReadmePath, Buffer.from(englishReadme)],
        [chineseReadmePath, Buffer.from(chineseReadme)],
        [readmePagePath, Buffer.from(readmePage)],
    ])
    const fileSystem = {
        existsSync: (file) => files.has(file),
        mkdirSync: () => undefined,
        readFileSync: (file, encoding) => {
            const contents = files.get(file)
            if (!contents) throw new Error(`ENOENT: no such file or directory, open '${file}'`)
            return encoding ? contents.toString(encoding) : Buffer.from(contents)
        },
        readdirSync: () => [],
        rmSync: (file) => void files.delete(file),
        writeFileSync: (file, contents) => void files.set(file, Buffer.from(contents)),
    }
    const processRef = new EventEmitter()
    processRef.exits = []
    processRef.exit = (code) => processRef.exits.push(code)
    return {
        files,
        fileSystem,
        processRef,
        request: {
            cwd: root,
            section: "1.2.0",
            displayVersion: "1.2.0-devhash",
            repositoryUrl: REPOSITORY,
            ref: REF,
        },
    }
}

function assertUntouchedSources(state) {
    assert.deepEqual(state.files.get(chineseChangelogPath), chineseChangelog)
    assert.deepEqual(state.files.get(englishChangelogPath), englishChangelog)
    assert.deepEqual(state.files.get(englishReadmePath), englishReadme)
    assert.deepEqual(state.files.get(chineseReadmePath), chineseReadme)
    assert.deepEqual(state.files.get(readmePagePath), readmePage)
}

function assertNoDocuments(state) {
    for (const outputPath of Object.values(outputPaths)) assert.equal(state.files.has(outputPath), false, outputPath)
}

function assertRestored(state) {
    assertUntouchedSources(state)
    assert.equal(state.processRef.listenerCount("SIGINT"), 0)
    assert.equal(state.processRef.listenerCount("SIGTERM"), 0)
}

/** Count writes to the generated documents only, ignoring source restoration. */
function countDocumentWrites(state) {
    const counter = { writes: 0 }
    const write = state.fileSystem.writeFileSync
    state.fileSystem.writeFileSync = (file, contents) => {
        if (Object.values(outputPaths).includes(file)) counter.writes += 1
        write(file, contents)
    }
    return counter
}

test("the four generated documents are the only packaged documentation and the sources keep their bytes", async () => {
    const state = fixture()
    const result = await withPackageDocs(
        state.request,
        async ({ readmePath, changelogPath }) => {
            // The English editions are the two official VSCE assets; the Chinese
            // editions are ordinary files that VSCE never renames.
            assert.equal(readmePath, PACKAGE_DOCUMENTS.readmeEnglish)
            assert.equal(changelogPath, PACKAGE_DOCUMENTS.changelogEnglish)
            assertUntouchedSources(state)

            const englishNotes = state.files.get(outputPaths.changelogEnglish).toString("utf8")
            const chineseNotes = state.files.get(outputPaths.changelogChinese).toString("utf8")

            // The display version is the packaged manifest version, not the section.
            assert.match(englishNotes, /^## \[1\.2\.0-devhash\]$/m)
            assert.match(chineseNotes, /^## \[1\.2\.0-devhash\]$/m)
            // Each document carries one language body only.
            assert.match(englishNotes, /- Fix marketplace documentation\./)
            assert.ok(!englishNotes.includes("修复商店说明。"))
            assert.match(chineseNotes, /- 修复商店说明。/)
            assert.ok(!chineseNotes.includes("Fix marketplace documentation."))

            // The navigation is an online reference to the other language's maintained
            // current source at the packaged ref, anchored on the content section. It
            // carries no online suffix, no package-local switch and no link into the
            // generated output directory.
            assert.ok(englishNotes.includes(`${REPOSITORY}/blob/${REF}/CHANGELOG.md#120`))
            assert.ok(chineseNotes.includes(`${REPOSITORY}/blob/${REF}/docs/changelog/CHANGELOG_en.md#120`))
            for (const notes of [englishNotes, chineseNotes]) {
                assert.ok(!notes.includes("dist/docs"))
                assert.ok(!notes.includes("blob/dev/"))
                assert.ok(!notes.includes("（在线）"))
                assert.ok(!notes.includes("(online)"))
            }
            assert.ok(englishNotes.includes("English | ["))
            assert.ok(chineseNotes.includes(") | 中文"))
            assert.equal(load(markdown.render(englishNotes))("h1").text(), "Changelog")
            assert.equal(load(markdown.render(chineseNotes))("h1").text(), "更新日志")

            // README links become absolute at the packaged ref instead of resolving
            // against the repository's default branch.
            const englishReadmeOut = state.files.get(outputPaths.readmeEnglish).toString("utf8")
            const chineseReadmeOut = state.files.get(outputPaths.readmeChinese).toString("utf8")
            assert.ok(englishReadmeOut.includes(`${REPOSITORY}/blob/${REF}/marketplace.zh-cn.md`))
            assert.ok(englishReadmeOut.includes(`${REPOSITORY}/blob/${REF}/docs/changelog/CHANGELOG_en.md`))
            assert.ok(chineseReadmeOut.includes(`${REPOSITORY}/blob/${REF}/README.marketplace.md`))
            assert.ok(chineseReadmeOut.includes(`${REPOSITORY}/blob/${REF}/CHANGELOG.md`))
            assert.ok(!englishReadmeOut.includes("blob/HEAD/"))

            // The adapter passes the generated paths as VSCE's `readmePath` and
            // `changelogPath`, so the processors rename them to the two official
            // assets instead of looking for the repository sources.
            const readmeProcessor = new ReadmeProcessor(
                { name: "fixture", publisher: "example", version: "1.2.0-devhash", engines: { vscode: "^1.134.0" } },
                { readmePath },
            )
            const readmeAsset = await readmeProcessor.onFile({
                path: `extension/${readmePath}`,
                contents: state.files.get(outputPaths.readmeEnglish),
            })
            assert.equal(readmeAsset.path, "extension/readme.md")
            assert.deepEqual(readmeProcessor.assets, [
                { type: "Microsoft.VisualStudio.Services.Content.Details", path: "extension/readme.md" },
            ])

            const processor = new ChangelogProcessor(
                { name: "fixture", publisher: "example", version: "1.2.0-devhash", engines: { vscode: "^1.134.0" } },
                { changelogPath },
            )
            const primary = await processor.onFile({
                path: `extension/${changelogPath}`,
                contents: state.files.get(outputPaths.changelogEnglish),
            })
            assert.equal(primary.path, "extension/changelog.md")
            assert.equal(primary.contents.toString("utf8"), englishNotes)
            assert.deepEqual(processor.assets, [
                { type: "Microsoft.VisualStudio.Services.Content.Changelog", path: "extension/changelog.md" },
            ])
            return "packed"
        },
        state,
    )
    assert.equal(result, "packed")
    assertNoDocuments(state)
    assertRestored(state)
})

test("an Unreleased build with no recorded changes states that per language instead of borrowing a release", async () => {
    const state = fixture()
    const emptyChinese = Buffer.from("\uFEFF# Changelog\r\n\r\n## [Unreleased]\r\n")
    const emptyEnglish = Buffer.from("# Changelog\n\n## [Unreleased]\n")
    state.files.set(path.join(root, "docs/changelog/history.en.md"), englishChangelog)
    state.files.set(path.join(root, "docs/changelog/history.zh-CN.md"), chineseChangelog)
    state.files.set(chineseChangelogPath, Buffer.from(emptyChinese))
    state.files.set(englishChangelogPath, Buffer.from(emptyEnglish))

    let englishNotes = ""
    let chineseNotes = ""
    await withPackageDocs(
        { ...state.request, section: UNRELEASED_SECTION },
        () => {
            englishNotes = state.files.get(outputPaths.changelogEnglish).toString("utf8")
            chineseNotes = state.files.get(outputPaths.changelogChinese).toString("utf8")
        },
        state,
    )

    // Released notes exist only in history; an empty current never borrows them.
    for (const notes of [englishNotes, chineseNotes]) {
        assert.ok(!notes.includes("旧版条目。"))
        assert.ok(!notes.includes("Older entry."))
        assert.ok(!notes.includes("Unreleased"))
    }
    // Each language states its own emptiness instead of the build looking complete.
    assert.match(englishNotes, /No changes are recorded for this build yet\./)
    assert.match(chineseNotes, /此构建尚无已记录的新增变更。/)
    assert.ok(!englishNotes.includes("此构建尚无已记录的新增变更。"))
    assert.ok(!chineseNotes.includes("No changes are recorded for this build yet."))
    // Both editions still navigate to the other maintained current source.
    assert.ok(englishNotes.includes(`${REPOSITORY}/blob/${REF}/CHANGELOG.md#unreleased`))

    assertNoDocuments(state)
    // Both overridden sources keep their exact bytes, so even this path never
    // rewrites a history to fill the gap.
    assert.deepEqual(state.files.get(chineseChangelogPath), emptyChinese)
    assert.deepEqual(state.files.get(englishChangelogPath), emptyEnglish)
    assert.equal(state.processRef.listenerCount("SIGINT"), 0)
    assert.equal(state.processRef.listenerCount("SIGTERM"), 0)
})

test("a worker failure releases all four generated documents and preserves the sources", async () => {
    const state = fixture()
    await assert.rejects(
        withPackageDocs(
            state.request,
            () => {
                for (const outputPath of Object.values(outputPaths)) assert.equal(state.files.has(outputPath), true)
                throw new Error("Worker failed")
            },
            state,
        ),
        /Worker failed/,
    )
    assertNoDocuments(state)
    assertRestored(state)
})

for (const [name, failingPath] of [
    ["second", outputPaths.readmeChinese],
    ["third", outputPaths.changelogEnglish],
    ["fourth", outputPaths.changelogChinese],
]) {
    test(`a partial write of the ${name} document releases every document and never starts the worker`, async () => {
        const state = fixture()
        const write = state.fileSystem.writeFileSync
        let started = false
        state.fileSystem.writeFileSync = (file, contents) => {
            if (file !== failingPath) {
                write(file, contents)
                return
            }
            write(file, Buffer.from(contents).subarray(0, 12))
            throw new Error("ENOSPC")
        }
        await assert.rejects(
            withPackageDocs(
                state.request,
                () => {
                    started = true
                },
                state,
            ),
            /ENOSPC/,
        )
        assert.equal(started, false)
        assertNoDocuments(state)
        assertRestored(state)
    })
}

for (const [missing, expected] of [
    ["README.marketplace.md", /Marketplace README source 'README\.marketplace\.md' could not be read/],
    ["marketplace.zh-cn.md", /Chinese README source 'marketplace\.zh-cn\.md' could not be read/],
    ["docs/changelog/CHANGELOG_en.md", /Changelog 'docs\/changelog\/CHANGELOG_en\.md' could not be read/],
    ["CHANGELOG.md", /Changelog 'CHANGELOG\.md' could not be read/],
]) {
    test(`a missing ${missing} names the file and never writes or starts the worker`, async () => {
        const state = fixture()
        state.files.delete(path.join(root, ...missing.split("/")))
        // Snapshot after removal: every remaining source must still be byte-identical.
        const remaining = new Map(state.files)
        const counter = countDocumentWrites(state)
        await assert.rejects(
            withPackageDocs(state.request, () => assert.fail("Worker must not start"), state),
            expected,
        )
        assert.equal(counter.writes, 0)
        assertNoDocuments(state)
        assert.deepEqual(state.files, remaining)
    })
}

test("an unusable repository or ref fails before anything is written", async () => {
    for (const [request, expected] of [
        [{ repositoryUrl: "" }, /requires the manifest repository URL; none was given\./],
        [{ ref: "" }, /requires the documentation ref; none was given\./],
    ]) {
        const state = fixture()
        const counter = countDocumentWrites(state)
        await assert.rejects(
            withPackageDocs({ ...state.request, ...request }, () => assert.fail("Worker must not start"), state),
            expected,
        )
        assert.equal(counter.writes, 0)
        assertNoDocuments(state)
        assertUntouchedSources(state)
    }
})

test("mismatched release sections fail before anything is written", async () => {
    const state = fixture()
    state.files.set(englishChangelogPath, Buffer.from(englishChangelog.toString().replace("## [1.2.0]", "## [1.0.0]")))
    const counter = countDocumentWrites(state)
    await assert.rejects(
        withPackageDocs(state.request, () => assert.fail("Worker must not start"), state),
        /different sections per language.*1\.0\.0.*1\.2\.0/,
    )
    assert.equal(counter.writes, 0)
    assertNoDocuments(state)
})

for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
]) {
    test(`${signal} releases every generated document through the existing cleanup owner`, async () => {
        const state = fixture()
        await withPackageDocs(
            state.request,
            () => {
                state.processRef.emit(signal)
                assertNoDocuments(state)
                assertUntouchedSources(state)
            },
            state,
        )
        assert.deepEqual(state.processRef.exits, [exitCode])
        assertRestored(state)
    })
}

test("a nested owner releases every generated document before the outer signal handler exits", async () => {
    const state = fixture()
    let manifestRestored = false
    state.processRef.exit = (code) => {
        assert.equal(manifestRestored, true)
        assertNoDocuments(state)
        assertUntouchedSources(state)
        state.processRef.exits.push(code)
    }
    await withSignalSafeCleanup(async (cleanups) => {
        cleanups.defer(() => {
            manifestRestored = true
        })
        await withPackageDocs(state.request, () => state.processRef.emit("SIGTERM"), { ...state, cleanups })
    }, state)
    assert.deepEqual(state.processRef.exits, [143])
    assertRestored(state)
})

test("mixed pre-existing output is restored byte for byte and a foreign file is never removed", async () => {
    const state = fixture()
    const earlierEnglishReadme = Buffer.from("# another run's English edition\n")
    const earlierChineseNotes = Buffer.from("# another run's Chinese notes\n")
    const foreignPath = path.join(root, "dist", "docs", "foreign.md")
    const legacyPath = path.join(root, "dist", "CHANGELOG.vsix.md")
    state.files.set(outputPaths.readmeEnglish, earlierEnglishReadme)
    state.files.set(outputPaths.changelogChinese, earlierChineseNotes)
    state.files.set(foreignPath, Buffer.from("# a file this call must not delete\n"))
    state.files.set(legacyPath, Buffer.from("# an older single-note output\n"))

    await withPackageDocs(state.request, () => undefined, state)

    // The two documents another run left are restored; the two this call created
    // are released. Nothing else in dist/ or dist/docs is touched.
    assert.deepEqual(state.files.get(outputPaths.readmeEnglish), earlierEnglishReadme)
    assert.deepEqual(state.files.get(outputPaths.changelogChinese), earlierChineseNotes)
    assert.equal(state.files.has(outputPaths.readmeChinese), false)
    assert.equal(state.files.has(outputPaths.changelogEnglish), false)
    assert.deepEqual(state.files.get(foreignPath), Buffer.from("# a file this call must not delete\n"))
    assert.deepEqual(state.files.get(legacyPath), Buffer.from("# an older single-note output\n"))
    assertRestored(state)
})

test("both listing sources remove the logo directly and retain the two demonstration images", () => {
    for (const file of ["README.marketplace.md", "marketplace.zh-cn.md"]) {
        const content = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
        const document = load(markdown.render(content))
        const images = document("img[src]")
            .toArray()
            .map((image) => image.attribs.src)
        assert.deepEqual(images, ["assets/docs/marketplace/dline-demo.gif", "assets/docs/marketplace/r2-quick-start.gif"])
        assert.equal(document("h1").text(), "Dline")
    }
})

function distributionFixture() {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
    const identities = JSON.parse(readFileSync(new URL("../../src/shared/extension-distributions.json", import.meta.url), "utf8"))
    const source = readFileSync(new URL("../../src/registry.ts", import.meta.url), "utf8")
    const compiled = require("esbuild").transformSync(source, { loader: "ts", format: "cjs", target: "node24" }).code
    const module = { exports: {} }
    runInNewContext(compiled, {
        module,
        exports: module.exports,
        require: (name) => {
            if (name === "../package.json") return manifest
            if (name === "./shared/extension-distributions.json") return identities
            if (name === "./hosts/host-provider") return { HostProvider: {} }
            throw new Error(`Unexpected registry dependency: ${name}`)
        },
    })
    return { manifest, createRuntime: module.exports.createExtensionRegistryInfo }
}

function vscodeGlobalIds(runtime) {
    return [
        ...Object.values(runtime.commands),
        ...Object.values(runtime.views),
        ...Object.values(runtime.viewContainers),
        ...Object.values(runtime.contextKeys),
        runtime.panelViewType,
        runtime.diffUriScheme,
        runtime.commentControllerId,
        runtime.productIconId,
        runtime.walkthrough.qualifiedId,
    ]
}

test("distribution manifests and actual runtime registrations stay aligned and pairwise isolated", () => {
    const { manifest, createRuntime } = distributionFixture()
    const distributions = ["dline", "dline-main", "dline-insiders"].map((name) => {
        const packaged = createDistributionManifest(manifest, name, "0.14.0", name === "dline" ? "tuvokyang" : "tuvokyangdline")
        const runtime = createRuntime(packaged)
        const commands = new Set(Object.values(runtime.commands))
        for (const command of packaged.contributes.commands) assert.ok(commands.has(command.command), command.command)
        assert.equal(packaged.contributes.viewsContainers.activitybar[0].id, runtime.viewContainers.ActivityBar)
        assert.equal(packaged.contributes.views[runtime.viewContainers.ActivityBar][0].id, runtime.views.Sidebar)
        for (const menu of packaged.contributes.menus["view/title"]) {
            assert.ok(menu.when.includes(runtime.views.Sidebar), menu.when)
            assert.ok(commands.has(menu.command), menu.command)
        }
        return runtime
    })
    for (let left = 0; left < distributions.length; left += 1) {
        for (let right = left + 1; right < distributions.length; right += 1) {
            const owned = new Set(vscodeGlobalIds(distributions[left]))
            assert.deepEqual(
                vscodeGlobalIds(distributions[right]).filter((id) => owned.has(id)),
                [],
            )
        }
    }
    assert.equal(distributions[1].panelViewType, "dlineMainTask")
    assert.equal(distributions[1].isInsiders, false)
})

test("Marketplace Stable preserves shortcuts and redirects them only to its own registered commands", () => {
    const { manifest } = distributionFixture()
    const original = structuredClone(manifest)
    const packaged = createDistributionManifest(manifest, "dline-main", "0.14.0", "tuvokyangdline")
    const commands = new Set(packaged.contributes.commands.map((command) => command.command))
    assert.equal(packaged.contributes.keybindings.length, manifest.contributes.keybindings.length)
    for (const [index, binding] of packaged.contributes.keybindings.entries()) {
        const { command: _oldCommand, when: _oldWhen, ...originalKeys } = manifest.contributes.keybindings[index]
        const { command: _command, when: _when, ...keys } = binding
        assert.deepEqual(keys, originalKeys)
        if (binding.command !== "editor.action.submitComment") assert.ok(commands.has(binding.command), binding.command)
    }
    assert.deepEqual(manifest, original)
    const insiders = createDistributionManifest(manifest, "dline-insiders", "0.15.1234567890")
    assert.deepEqual(
        insiders.contributes.keybindings.map((binding) => binding.command),
        ["editor.action.submitComment"],
    )
})
