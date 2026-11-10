import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import packageJson from "../../package.json"
import {
    createDistributionManifest,
    resolveTargetIdentity,
    VSCODE_MARKETPLACE_PACKAGE_NAME,
} from "../../scripts/extension-manifest-identity.mjs"

/**
 * The packaging script is a standalone ESM entry that resolves its channel at
 * import time and calls vsce, so it cannot be imported here without packaging.
 * These tests therefore pin the release contract at the source level: the rules
 * below are the ones a mis-tagged or under-documented release would violate.
 */

const PROJECT_ROOT = process.cwd()

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
        expect(marketplace.contributes.keybindings).toHaveLength(packageJson.contributes.keybindings.length)
        for (const [index, binding] of marketplace.contributes.keybindings.entries()) {
            const sourceBinding: { key: string; mac?: string; win?: string; linux?: string } =
                packageJson.contributes.keybindings[index]
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
        expect(draft).toContain('node scripts/extract-changelog-section.mjs CHANGELOG.md "$VERSION"')
        expect(draft).not.toContain("dline-preview")
        expect(registries).toContain('($channel == "pre-release" and .preview != true and .version == $version)')
        expect(registries).toContain("track_args=(--pre-release)")
        expect(registries).toContain("Error: production VSIX is marked as a pre-release.")
        expect(packager).toContain("preRelease: options.preRelease")
    })

    it("packages an explicit Insiders build even when a dev-vX.Y.Z tag names the same commit", async () => {
        const source = await readPackageVsix()

        // A dev-vX.Y.Z tag must name the dev head, and every dev push packages
        // that head as Insiders. The explicit Insiders branch therefore resolves
        // before any tag lookup instead of rejecting a tagged commit.
        expect(source).not.toContain("Insiders packaging requires an untagged commit")
        const insidersBranch = source.slice(source.indexOf('if (requestedChannel === "insiders") {'))
        const insidersReturn = insidersBranch.indexOf('return { channel: "insiders"')
        expect(insidersReturn).toBeGreaterThan(-1)
        expect(insidersReturn).toBeLessThan(insidersBranch.indexOf("getExactTag()"))
    })

    it("delegates channel version parity and the insiders version to the release version policy", async () => {
        const source = await readPackageVsix()

        expect(source).toContain('from "./release-version-policy.mjs"')
        expect(source).toContain("assertChannelVersion(channel, tagVersion)")
        expect(source).toContain("createPolicyInsidersVersion(packageVersion)")
    })

    it("gates tagged channels on version and changelog consistency", async () => {
        const source = await readPackageVsix()

        expect(source).toContain("assertReleaseVersionConsistency")
        expect(source).toContain("CHANGELOG.md")
        expect(source).toContain("CHANGELOG_en.md")
        expect(source).toContain("changelogDocumentsVersion")
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
    it("documents the current package version in both editions", async () => {
        const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8")) as { version: string }
        const heading = `## [${pkg.version}]`

        for (const relativePath of ["CHANGELOG.md", "docs/changelog/CHANGELOG_en.md"]) {
            const content = await fs.readFile(path.join(PROJECT_ROOT, relativePath), "utf8")
            const hasHeading = content.split(/\r?\n/).some((line) => line.trim() === heading)
            expect(hasHeading, `${relativePath} must contain '${heading}'`).toBe(true)
        }
    })
})
