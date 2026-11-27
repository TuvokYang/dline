import fs from "node:fs/promises"
import path from "node:path"
import { runInNewContext } from "node:vm"
import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import packageJson from "../../package.json"
import { readChangelog } from "../../scripts/changelog.mjs"
import { parseChangelog } from "../../scripts/changelog-parser.mjs"
import {
    createDistributionManifest,
    resolveTargetIdentity,
    VSCODE_MARKETPLACE_PACKAGE_NAME,
} from "../../scripts/extension-manifest-identity.mjs"
import {
    assertChannelVersion,
    createInsidersVersion as createPolicyInsidersVersion,
} from "../../scripts/release-version-policy.mjs"
// @ts-expect-error -- packaging scripts are plain ESM without type declarations.
import { UNRELEASED_SECTION } from "../../scripts/vsix-changelog.mjs"

/** Standalone entries are evaluated only at their selection boundary, without running a build. */

const PROJECT_ROOT = process.cwd()

interface ResolvedChannel {
    channel: string
    version: string
    tag: string | null
    changelogSection: string
}

interface ChannelHarness {
    selectChangelogSection: (tag: string | null) => string
    resolveRequestedChannel: (requestedChannel: string, packageVersion: string) => ResolvedChannel
}

const BINDINGS = {
    UNRELEASED_SECTION,
    // The extractor's selector for the current (development) changelog section.
    CURRENT_SECTION: "current",
    assertChannelVersion,
    createPolicyInsidersVersion,
}

/** Execute the entry's actual declarations; never evaluate its top-level build or filesystem operations. */
async function loadChannelHarness(
    relativePath: string,
    names: readonly (keyof ChannelHarness)[],
    git: { branch: string | null; tags: string[] },
    bindings: typeof BINDINGS,
): Promise<ChannelHarness> {
    const source = await fs.readFile(path.join(PROJECT_ROOT, relativePath), "utf8")
    const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true)
    // This explicit fixture boundary is intentionally not a dependency-discovery engine.
    const dependencies = names.includes("selectChangelogSection")
        ? ["RELEASE_TAG_PATTERN", "selectChangelogSection"]
        : [
              "PRODUCTION_TAG_PATTERN",
              "DEV_TAG_PATTERN",
              "INSIDERS_DRAFT_TAG_PATTERN",
              "PRE_RELEASE_CHANNEL",
              "tryGit",
              "getExactTag",
              "getCurrentBranch",
              "fail",
              "assertReleaseVersionConsistency",
              "createInsidersVersion",
              "resolveChannel",
              "resolveRequestedChannel",
          ]
    const declarations = new Map<string, string>()
    for (const statement of file.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name && dependencies.includes(statement.name.text)) {
            declarations.set(statement.name.text, statement.getText(file))
        }
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && dependencies.includes(declaration.name.text)) {
                    declarations.set(declaration.name.text, `const ${declaration.getText(file)};`)
                }
            }
        }
    }
    for (const name of dependencies) {
        if (!declarations.has(name)) throw new Error(`${relativePath} declares no ${name}`)
    }
    const gitCommands: Record<string, string | null> = {
        "git branch --show-current": git.branch,
        "git tag --points-at HEAD": git.tags.join("\n"),
    }
    const reported: string[] = []
    return runInNewContext(`${[...declarations.values()].join("\n")}\n;({${names.join(",")}})`, {
        ...bindings,
        PROJECT_ROOT,
        console: { error: (message: string) => reported.push(message) },
        process: {
            exit: (code: number) => {
                throw new Error(reported.at(-1) ?? `Process exited with ${code}.`)
            },
        },
        execSync: (command: string) => {
            if (!(command in gitCommands)) throw new Error(`Unexpected Git command: ${command}`)
            const output = gitCommands[command]
            if (output === null) throw new Error(`Git command failed: ${command}`)
            return output
        },
    }) as ChannelHarness
}

interface ManifestKeybinding {
    command: string
    key: string
    mac?: string
    win?: string
    linux?: string
}

async function readPackageVsix(): Promise<string> {
    return fs.readFile(path.join(PROJECT_ROOT, "scripts/package-vsix.mjs"), "utf8")
}

describe("package-vsix release channels", () => {
    it("recognises only the two public release tag formats and filters internal Insiders draft tags", async () => {
        const source = await readPackageVsix()

        expect(source).toContain("/^v(\\d+\\.\\d+\\.\\d+)$/")
        expect(source).toContain("/^dev-v(\\d+\\.\\d+\\.\\d+)$/")
        expect(source).toContain("/^insiders-[0-9a-f]{40}$/")
        expect(source).toContain('tryGit("git tag --points-at HEAD")')
        expect(source).toContain("INSIDERS_DRAFT_TAG_PATTERN.test(tag)")
        // Selecting from all exact tags prevents an internal draft tag from masking dev-vX.Y.Z.
        expect(source).not.toContain("git describe --tags --exact-match")
        expect(source).not.toMatch(/function isOnTag\b/)
    })

    it.each(["tuvokyang", "tuvokyangdline"])("preserves the stable contribution contract for publisher %s", (publisher) => {
        const manifest = createDistributionManifest(packageJson, "dline", "0.13.0", publisher)

        expect(manifest.name).toBe("dline")
        expect(manifest.publisher).toBe(publisher)
        expect(manifest.version).toBe("0.13.0")
        expect(manifest).not.toHaveProperty("preview", true)
        expect(manifest.contributes).toEqual(packageJson.contributes)
        expect(manifest.activationEvents).toEqual(packageJson.activationEvents)
    })

    it("gives the VS Code Marketplace its own registry-wide unique identity", async () => {
        const marketplace = createDistributionManifest(packageJson, VSCODE_MARKETPLACE_PACKAGE_NAME, "0.13.0", "tuvokyangdline")
        const openVsx = createDistributionManifest(packageJson, "dline", "0.13.0", "tuvokyang")

        // The Marketplace rejects a name another publisher already owns, so the
        // Marketplace build must not reuse the Open VSX identity.
        expect(marketplace.name).toBe("dline-main")
        expect(marketplace.displayName).toBe("Dline (Stable)")
        expect(marketplace.publisher).toBe("tuvokyangdline")
        expect(openVsx.name).toBe("dline")
        expect(openVsx.displayName).toBe("Dline")
        expect(openVsx.publisher).toBe("tuvokyang")

        const sourceCommands = new Set(openVsx.contributes.commands.map(({ command }) => command))
        const marketplaceCommands = new Set(marketplace.contributes.commands.map(({ command }) => command))
        expect([...marketplaceCommands].every((command) => !sourceCommands.has(command))).toBe(true)
        expect(marketplace.contributes.viewsContainers.activitybar[0].id).not.toBe(
            openVsx.contributes.viewsContainers.activitybar[0].id,
        )
        const sourceBindings: ManifestKeybinding[] = packageJson.contributes.keybindings
        const marketplaceBindings: ManifestKeybinding[] = marketplace.contributes.keybindings
        expect(marketplaceBindings).toHaveLength(sourceBindings.length)
        for (const [index, binding] of marketplaceBindings.entries()) {
            const sourceBinding = sourceBindings[index]
            expect([binding.key, binding.mac, binding.win, binding.linux]).toEqual([
                sourceBinding.key,
                sourceBinding.mac,
                sourceBinding.win,
                sourceBinding.linux,
            ])
            if (binding.command !== "editor.action.submitComment") expect(marketplaceCommands.has(binding.command)).toBe(true)
        }
        expect(marketplace.activationEvents).toEqual(openVsx.activationEvents)
    })

    it.each([
        ["ci", "open-vsx", "dline", "tuvokyang"],
        ["pre-release", "open-vsx", "dline", "tuvokyang"],
        ["production", "open-vsx", "dline", "tuvokyang"],
        ["ci", "vscode-marketplace", "dline-main", "tuvokyangdline"],
        ["pre-release", "vscode-marketplace", "dline-main", "tuvokyangdline"],
        ["production", "vscode-marketplace", "dline-main", "tuvokyangdline"],
        ["insiders", "open-vsx", "dline-insiders", "tuvokyang"],
        ["insiders", "vscode-marketplace", "dline-insiders", "tuvokyangdline"],
    ] as [
        string,
        string,
        string,
        string,
    ][])("resolves the %s channel on %s to %s under %s", (channel, registry, expectedName, expectedPublisher) => {
        expect(resolveTargetIdentity(channel, registry, packageJson.name, packageJson.publisher)).toEqual({
            packageName: expectedName,
            publisher: expectedPublisher,
        })
    })

    it("keeps an explicit publisher override while still applying the registry package name", () => {
        expect(
            resolveTargetIdentity("production", "vscode-marketplace", packageJson.name, packageJson.publisher, "other"),
        ).toEqual({
            packageName: "dline-main",
            publisher: "other",
        })
    })

    it("publishes dev-vX.Y.Z to the pre-release track of the production extension", async () => {
        const draft = await fs.readFile(path.join(PROJECT_ROOT, ".github/workflows/release-draft.yml"), "utf8")
        const registries = await fs.readFile(path.join(PROJECT_ROOT, ".github/workflows/publish-vsix-registries.yml"), "utf8")
        const packager = await fs.readFile(path.join(PROJECT_ROOT, "scripts/vsix-packager.mjs"), "utf8")

        expect(draft).toContain("package_channel: pre-release")
        expect(draft).toContain('.name == "dline" and')
        expect(draft).toContain("Microsoft.VisualStudio.Code.PreRelease")
        // The notes step reads the accurate version from the shared reader through the
        // thin CLI, never from the generated entry pages.
        expect(draft).toContain(
            'node scripts/extract-changelog-section.mjs --version "$VERSION" --language zh-CN --output "$RUNNER_TEMP/release-notes.md"',
        )
        expect(draft).not.toContain("extract-changelog-section.mjs CHANGELOG.md")
        expect(draft).not.toContain("dline-preview")
        expect(registries).toContain('($channel == "pre-release" and .preview != true and .version == $version)')
        expect(registries).toContain("track_args=(--pre-release)")
        expect(registries).toContain("Error: production VSIX is marked as a pre-release.")
        expect(packager).toContain("preRelease: options.preRelease")
        // The generated documents are the only Readme and Changelog assets VSCE is
        // told to read, and the worker refuses to package without both of them.
        expect(packager).toContain("readmePath")
        expect(packager).toContain("packageOptions.readmePath = options.readmePath")
        expect(packager).toContain("packageOptions.changelogPath = options.changelogPath")
        expect(packager).toContain("refusing to package without them")
    })

    it.each([
        // A formal version tag of either channel documents that exact section.
        ["v0.14.0", "0.14.0"],
        ["dev-v0.13.0", "0.13.0"],
        // Every untagged or non-version commit documents the current section,
        // which is the development one until a release freezes it. The
        // extractor selects it with the literal keyword "current".
        [null, "current"],
        ["nightly", "current"],
        ["insiders-0123456789abcdef0123456789abcdef01234567", "current"],
    ])("selects %s as the local development changelog section", async (tag, expected) => {
        const harness = await loadChannelHarness(
            "scripts/package-dev.mjs",
            ["selectChangelogSection"],
            { branch: "dev", tags: tag === null ? [] : [tag] },
            BINDINGS,
        )

        expect(harness.selectChangelogSection(tag)).toBe(expected)
    })

    it("keeps the local development and E2E entries on the shared adapter", async () => {
        const packageDev = await fs.readFile(path.join(PROJECT_ROOT, "scripts/package-dev.mjs"), "utf8")
        const e2e = await fs.readFile(path.join(PROJECT_ROOT, "scripts/e2e-package.mjs"), "utf8")

        for (const [source, expected] of [
            [packageDev, { mode: "pack-only", changelogSection: "$changelogSection", documentationRef: "$documentationRef" }],
            [e2e, { mode: "build-and-pack", changelogSection: "current", documentationRef: "$documentationRef" }],
        ] as const) {
            const parsed = ts.createSourceFile("entry.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
            const calls: Record<string, string>[] = []
            const visit = (node: ts.Node): void => {
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "packageVsix") {
                    const [argument] = node.arguments
                    if (argument && ts.isObjectLiteralExpression(argument)) {
                        const fields: Record<string, string> = {}
                        for (const property of argument.properties) {
                            if (ts.isShorthandPropertyAssignment(property)) fields[property.name.text] = `$${property.name.text}`
                            else if (ts.isPropertyAssignment(property)) {
                                fields[property.name.getText(parsed)] = ts.isStringLiteral(property.initializer)
                                    ? property.initializer.text
                                    : `$${property.initializer.getText(parsed)}`
                            }
                        }
                        calls.push(fields)
                    }
                }
                ts.forEachChild(node, visit)
            }
            visit(parsed)
            expect(calls).toEqual([expect.objectContaining(expected)])
        }
    })

    it("packages the generated documents by path instead of swapping the root README", async () => {
        for (const entry of ["scripts/package-vsix.mjs", "scripts/package-dev.mjs"]) {
            const source = await fs.readFile(path.join(PROJECT_ROOT, entry), "utf8")

            // Local entries pass explicit VSCE paths, so the root README stays a
            // repository landing page and only this call's manifest is restored.
            expect(source, `${entry} must keep the manifest cleanup owner`).toContain("withSignalSafeCleanup(")
            expect(source, `${entry} must restore package.json`).toContain("cleanups.defer(")
            expect(source, `${entry} must not swap the root README`).not.toContain("withMarketplaceReadme")
            expect(source, `${entry} must not swap the root README`).not.toContain("swapIn")
        }

        // The legacy publish consumers keep the swap API and its CLI untouched.
        for (const legacy of ["scripts/publish-marketplace.mjs", "scripts/publish-insiders.mjs"]) {
            const source = await fs.readFile(path.join(PROJECT_ROOT, legacy), "utf8")
            expect(source, `${legacy} must keep the legacy README swap`).toContain("swapIn")
        }
        const readme = await fs.readFile(path.join(PROJECT_ROOT, "scripts/marketplace-readme.mjs"), "utf8")
        expect(readme).toContain("export function swapIn")
        expect(readme).toContain("export function restore")
        expect(readme).toContain("export async function withMarketplaceReadme")
        expect(readme).toContain('if (cmd === "swap-in")')
    })

    it("packages an explicit Insiders build even when a dev-vX.Y.Z tag names the same commit", async () => {
        const source = await readPackageVsix()

        // A dev-vX.Y.Z tag must name the dev head, and every dev push packages
        // that head as Insiders. The explicit Insiders branch therefore resolves
        // before any tag lookup instead of rejecting a tagged commit.
        expect(source).not.toContain("Insiders packaging requires an untagged commit")
        const insidersBranch = source.slice(source.indexOf('if (requestedChannel === "insiders") {'))
        const insidersReturn = insidersBranch.indexOf('channel: "insiders"')
        expect(insidersReturn).toBeGreaterThan(-1)
        expect(insidersReturn).toBeLessThan(insidersBranch.indexOf("getExactTag()"))
    })

    it("delegates channel version parity and the insiders version to the release version policy", async () => {
        const source = await readPackageVsix()

        expect(source).toContain('from "./release-version-policy.mjs"')
        expect(source).toContain("assertChannelVersion(channel, tagVersion)")
        expect(source).toContain("createPolicyInsidersVersion(packageVersion)")
    })

    it("gates tagged channels on the tag matching the version it publishes", async () => {
        const source = await readPackageVsix()

        expect(source).toContain("assertReleaseVersionConsistency")
        expect(source).toContain("Bump the version first.")
        // The bilingual notes themselves are validated by the generator, so the
        // channel gate no longer reads either history directly.
        expect(source).not.toContain("changelogDocumentsVersion")
        expect(source).not.toContain('path.join(PROJECT_ROOT, "CHANGELOG.md")')
    })

    const builds: [string, string, string[], string, string, string][] = [
        ["auto", "main", ["v0.14.0"], "0.14.0", "production", "0.14.0"],
        ["auto", "dev", ["dev-v0.15.0"], "0.15.0", "pre-release", "0.15.0"],
        ["auto", "dev", [], "0.14.0", "insiders", "current"],
        ["ci", "dev", [], "0.14.0", "ci", "current"],
        ["insiders", "dev", ["dev-v0.15.0"], "0.15.0", "insiders", "current"],
        ["production", "main", ["v0.14.0"], "0.14.0", "production", "0.14.0"],
        ["pre-release", "dev", ["dev-v0.15.0"], "0.15.0", "pre-release", "0.15.0"],
    ]
    for (const [requested, branch, tags, version, channel, section] of builds) {
        it(`selects ${requested} on ${branch} with ${tags.join(",") || "no tag"} as ${section}`, async () => {
            const harness = await loadChannelHarness(
                "scripts/package-vsix.mjs",
                ["resolveRequestedChannel"],
                { branch, tags },
                BINDINGS,
            )
            const resolved = harness.resolveRequestedChannel(requested, version)

            expect(resolved.channel).toBe(channel)
            expect(resolved.changelogSection).toBe(section)
        })
    }

    it("rejects a release channel that has no matching version tag instead of selecting a section", async () => {
        const harness = await loadChannelHarness(
            "scripts/package-vsix.mjs",
            ["resolveRequestedChannel"],
            { branch: "dev", tags: [] },
            BINDINGS,
        )

        expect(() => harness.resolveRequestedChannel("production", "0.14.0")).toThrow(
            "production packaging requires an exact vX.Y.Z tag at HEAD.",
        )
        expect(() => harness.resolveRequestedChannel("pre-release", "0.15.0")).toThrow(
            "pre-release packaging requires an exact dev-vX.Y.Z tag at HEAD.",
        )
    })

    it("delegates section selection and the generated notes to the shared adapter", async () => {
        const source = await readPackageVsix()

        // The entry selects the section; the adapter renders and displays it.
        expect(source).toContain("await packageVsix({")
        expect(source).toContain("changelogSection,")
        expect(source).not.toContain("withEnglishChangelog")
        expect(source).not.toContain("CHANGELOG_en.md")
    })

    it("rejects untagged main and unknown branches instead of guessing a channel", async () => {
        const source = await readPackageVsix()

        expect(source).toContain("main has no release tag")
        expect(source).toContain("has no packaging channel")
        expect(source).toContain("must live on main")
        expect(source).toContain("must live on dev")
    })

    it("restores package.json even when packaging aborts", async () => {
        const source = await readPackageVsix()

        expect(source).toContain("cleanups.defer(")
        expect(source).toContain("Restoring original package.json")
    })
})

describe("changelog language editions", () => {
    it("keeps current in the original language files without a generated version index", async () => {
        const notes = readChangelog({ root: PROJECT_ROOT, version: "current" })
        const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8")) as { version: string }
        const lock = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package-lock.json"), "utf8")) as {
            version: string
            packages: Record<string, { version: string }>
        }
        expect([lock.version, lock.packages[""].version]).toEqual([pkg.version, pkg.version])
        for (const language of ["english", "chinese"] as const) {
            const content = await fs.readFile(path.join(PROJECT_ROOT, notes[language].sourcePath), "utf8")
            const parsed = parseChangelog(content)
            expect(parsed.sections.map((section) => section.version)).toEqual([notes.version])
            expect(parsed.sections[0].body).toBe(notes[language].body)
            expect(content).not.toMatch(/\]\([^)]*history[^)]*\)/)
        }
        expect(notes.english.sourcePath).toBe("docs/changelog/CHANGELOG_en.md")
        expect(notes.chinese.sourcePath).toBe("CHANGELOG.md")
    })

    it("reads a published version from the single history files explicitly", () => {
        const notes = readChangelog({ root: PROJECT_ROOT, version: "0.14.1", source: "history" })
        expect(notes.version).toBe("0.14.1")
        expect(notes.english.sourcePath).toBe("docs/changelog/history.en.md")
        expect(notes.chinese.sourcePath).toBe("docs/changelog/history.zh-CN.md")
        expect(notes.english.body.trim().length).toBeGreaterThan(0)
        expect(notes.chinese.body.trim().length).toBeGreaterThan(0)
    })
})
