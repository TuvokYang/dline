import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { createDistributionManifest } from "../extension-manifest-identity.mjs"
import { withSignalSafeCleanup } from "../signal-safe-cleanup.mjs"
import { withEnglishChangelog } from "../vsix-packager.mjs"

const require = createRequire(import.meta.url)
const { ChangelogProcessor } = require("@vscode/vsce/out/package.js")
const MarkdownIt = require("markdown-it")
const { load } = require("cheerio")
const markdown = new MarkdownIt({ html: true })
const root = path.resolve("tmp/virtual-changelog")
const chinesePath = path.join(root, "CHANGELOG.md")
const englishPath = path.join(root, "docs", "changelog", "CHANGELOG_en.md")
const chinese = Buffer.from("\uFEFF# Changelog\r\n\r\n## [1.2.0]\r\n\r\n- 修复商店说明。\r\n")
const english = Buffer.from("# Changelog\n\n## [1.2.0]\n\n- Fix marketplace documentation.\n")

function fixture() {
    const files = new Map([
        [chinesePath, Buffer.from(chinese)],
        [englishPath, Buffer.from(english)],
    ])
    const fileSystem = {
        readFileSync: (file) => {
            if (!files.has(file)) throw new Error("Missing changelog")
            return Buffer.from(files.get(file))
        },
        writeFileSync: (file, contents) => files.set(file, Buffer.from(contents)),
    }
    const processRef = new EventEmitter()
    processRef.exits = []
    processRef.exit = (code) => processRef.exits.push(code)
    return { files, fileSystem, processRef }
}

function assertRestored(fixture) {
    assert.deepEqual(fixture.files.get(chinesePath), chinese)
    assert.deepEqual(fixture.files.get(englishPath), english)
    assert.equal(fixture.processRef.listenerCount("SIGINT"), 0)
    assert.equal(fixture.processRef.listenerCount("SIGTERM"), 0)
}

test("VSCE's changelog asset reads English without mutating its source, then restores the root bytes", async () => {
    const state = fixture()
    const result = await withEnglishChangelog(
        root,
        async () => {
            assert.deepEqual(state.files.get(chinesePath), english)
            assert.deepEqual(state.files.get(englishPath), english)
            const processor = new ChangelogProcessor({
                name: "fixture",
                publisher: "example",
                version: "1.2.0",
                engines: { vscode: "^1.134.0" },
            })
            const primary = await processor.onFile({ path: "extension/CHANGELOG.md", contents: state.files.get(chinesePath) })
            assert.equal(primary.path, "extension/changelog.md")
            assert.deepEqual(primary.contents, english)
            assert.ok(
                processor.assets.some(
                    (asset) => asset.type === "Microsoft.VisualStudio.Services.Content.Changelog" && asset.path === primary.path,
                ),
            )
            return "packed"
        },
        state,
    )
    assert.equal(result, "packed")
    assertRestored(state)
})

test("worker failure restores the root changelog and preserves its English source", async () => {
    const state = fixture()
    await assert.rejects(
        withEnglishChangelog(
            root,
            () => {
                throw new Error("Worker failed")
            },
            state,
        ),
        /Worker failed/,
    )
    assertRestored(state)
})

test("a partial root replacement restores its bytes without starting the worker or changing the English source", async () => {
    const state = fixture()
    const write = state.fileSystem.writeFileSync
    let writes = 0
    let started = false
    state.fileSystem.writeFileSync = (file, content) => {
        if (++writes === 1) {
            write(file, Buffer.from(content).subarray(0, 8))
            throw new Error("ENOSPC")
        }
        write(file, content)
    }
    await assert.rejects(
        withEnglishChangelog(
            root,
            () => {
                started = true
            },
            state,
        ),
        /ENOSPC/,
    )
    assert.equal(started, false)
    assertRestored(state)
})

test("missing English source does not alter the Chinese source or start the worker", async () => {
    const state = fixture()
    state.files.delete(englishPath)
    let writes = 0
    state.fileSystem.writeFileSync = () => {
        writes += 1
    }
    await assert.rejects(
        withEnglishChangelog(root, () => assert.fail("Worker must not start"), state),
        /Missing changelog/,
    )
    assert.equal(writes, 0)
    assert.deepEqual(state.files.get(chinesePath), chinese)
})

for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
]) {
    test(`${signal} restores the root changelog through the existing cleanup owner`, async () => {
        const state = fixture()
        await withEnglishChangelog(
            root,
            () => {
                state.processRef.emit(signal)
                assert.deepEqual(state.files.get(chinesePath), chinese)
                assert.deepEqual(state.files.get(englishPath), english)
            },
            state,
        )
        assert.deepEqual(state.processRef.exits, [exitCode])
        assertRestored(state)
    })
}

test("nested packaging restores all documents before the outer signal handler exits", async () => {
    const state = fixture()
    let readmeRestored = false
    state.processRef.exit = (code) => {
        assert.equal(readmeRestored, true)
        assert.deepEqual(state.files.get(chinesePath), chinese)
        assert.deepEqual(state.files.get(englishPath), english)
        state.processRef.exits.push(code)
    }
    await withSignalSafeCleanup(async (cleanups) => {
        cleanups.defer(() => {
            readmeRestored = true
        })
        await withEnglishChangelog(root, () => state.processRef.emit("SIGTERM"), { ...state, cleanups })
    }, state)
    assert.deepEqual(state.processRef.exits, [143])
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
        const { command, when: _when, ...keys } = binding
        assert.deepEqual(keys, originalKeys)
        if (command !== "editor.action.submitComment") assert.ok(commands.has(command), command)
    }
    assert.deepEqual(manifest, original)
    const insiders = createDistributionManifest(manifest, "dline-insiders", "0.15.1234567890")
    assert.deepEqual(
        insiders.contributes.keybindings.map((binding) => binding.command),
        ["editor.action.submitComment"],
    )
})
