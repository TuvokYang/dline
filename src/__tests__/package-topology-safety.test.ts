import fs from "node:fs/promises"
import path from "node:path"
import { load as parseYaml } from "js-yaml"
import { describe, expect, it } from "vitest"

interface RootPackageJson {
    name: string
    workspaces?: string[] | string
    scripts?: Record<string, string>
}

interface RootPackageLock {
    packages?: Record<string, { link?: boolean; workspaces?: string[] }>
}

const PROJECT_ROOT = process.cwd()

async function readProjectFile(relativePath: string): Promise<string> {
    return fs.readFile(path.join(PROJECT_ROOT, relativePath), "utf8")
}

function normalizeWorkspace(workspace: string): string {
    const normalized = workspace.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
    return normalized || "."
}

function expectDirectVsceCommandsToDisableDependencyScanning(source: string, sourceName: string): void {
    const commands = source.split(/\r?\n/).filter((line) => {
        const trimmed = line.trimStart()
        return (
            /\bvsce\s+package\b/.test(line) && !trimmed.startsWith("#") && !trimmed.startsWith("//") && !trimmed.startsWith("*")
        )
    })

    for (const command of commands) {
        expect(command, `${sourceName} must disable VSIX dependency scanning`).toContain("--no-dependencies")
    }
}

describe("package topology safety", () => {
    it("does not declare the root package as its own npm workspace", async () => {
        const packageJson = JSON.parse(await readProjectFile("package.json")) as RootPackageJson
        const workspaces = Array.isArray(packageJson.workspaces)
            ? packageJson.workspaces
            : packageJson.workspaces
              ? [packageJson.workspaces]
              : []

        expect(workspaces.map(normalizeWorkspace)).not.toContain(".")

        const packageLock = JSON.parse(await readProjectFile("package-lock.json")) as RootPackageLock
        expect(packageLock.packages?.[""]?.workspaces?.map(normalizeWorkspace) ?? []).not.toContain(".")
        const selfLink = packageLock.packages?.[`node_modules/${packageJson.name}`]
        expect(
            selfLink?.link,
            `package-lock.json must not link node_modules/${packageJson.name} to the repository root`,
        ).not.toBe(true)
    })

    it("publishes one verified production artifact idempotently through either serialized path", async () => {
        const automaticWorkflow = await readProjectFile(".github/workflows/release.yml")
        const insidersWorkflow = await readProjectFile(".github/workflows/publish-insiders.yml")
        const manualWorkflow = await readProjectFile(".github/workflows/publish-vscode-marketplace.yml")
        const productionPublisher = await readProjectFile(".github/workflows/publish-production-release.yml")
        const registryWorkflow = await readProjectFile(".github/workflows/publish-vsix-registries.yml")

        expect(automaticWorkflow).toContain("group: production-release-${{ github.ref_name }}")
        expect(manualWorkflow).toContain("group: production-release-${{ inputs.tag }}")
        expect(automaticWorkflow).toContain("uses: ./.github/workflows/publish-production-release.yml")
        expect(manualWorkflow).toContain("uses: ./.github/workflows/publish-production-release.yml")
        expect(productionPublisher).toContain('gh release upload "$TAG" "$VSIX_PATH" --clobber')
        expect(productionPublisher).toContain('node scripts/extract-changelog-section.mjs CHANGELOG.md "$VERSION"')
        expect(productionPublisher).toContain('gh release create "$TAG" "$VSIX_PATH" --verify-tag --notes-file "$NOTES_PATH"')
        expect(productionPublisher).not.toContain("--generate-notes")
        expect(productionPublisher).toContain("Verify stable GitHub release asset")
        expect(productionPublisher).toContain("select(.name == $name and .size > 0)")
        expect(productionPublisher).toContain('select(.name | endswith(".vsix"))')
        expect(productionPublisher).toContain('expected_count" != "1" || "$vsix_count" != "1"')
        expect(productionPublisher).toContain("uses: ./.github/workflows/publish-vsix-registries.yml")
        expect(insidersWorkflow).toContain("group: publish-insiders")
        expect(insidersWorkflow).toContain("name: Checkout tested dev commit")
        expect(insidersWorkflow).toContain("ref: ${{ needs.verify-insiders.outputs.commit_sha }}")
        expect(insidersWorkflow).toContain("persist-credentials: false")
        expect(insidersWorkflow).toContain(
            'node scripts/extract-changelog-section.mjs CHANGELOG.md Unreleased "$unreleased_notes_path" --allow-empty',
        )
        expect(insidersWorkflow).toContain('if [[ -s "$unreleased_notes_path" ]]; then')
        expect(insidersWorkflow).toContain('cat "$unreleased_notes_path" >> "$notes_path"')
        expect(insidersWorkflow).toContain("Prune older Insiders drafts")
        expect(insidersWorkflow).toContain("select(.draft == true and .tag_name != $keep)")
        expect(insidersWorkflow).toContain('gh release delete "$stale_tag" --yes')
        expect(insidersWorkflow).toContain('remaining_drafts[0]}" != "$RELEASE_TAG"')
        expect(registryWorkflow).toContain('"$VSCE_BIN" publish --skip-duplicate "${track_args[@]}" --packagePath "$vsix_path"')
        expect(registryWorkflow).toContain('"$OVSX_BIN" publish "$vsix_path" --skip-duplicate')
        // Either registry can remain available when publication to the other fails.
        expect(registryWorkflow).toContain("if: inputs.publish_marketplace && github.repository == 'TuvokYang/dline'")
        expect(registryWorkflow).toContain(
            "MARKETPLACE_STATUS: ${{ inputs.publish_marketplace && (needs.publish-marketplace.outputs.status || 'unreported') || 'disabled' }}",
        )
        // A version already held by the other Open VSX track must fail instead of being skipped as published.
        expect(registryWorkflow).toContain('"https://open-vsx.org/api/${namespace}/${extension}/${version}"')
        expect(registryWorkflow).toContain('if [[ "$existing_pre_release" != "$expected_pre_release" ]]; then')
        // Publisher-specific workflow bindings are exercised in marketplace-publishing.test.ts.
    })

    it("keeps ordinary main source-only and tests each tagged production package before functional", async () => {
        interface Job {
            uses?: string
            needs?: string | string[]
            with?: Record<string, string>
            steps?: { name?: string; run?: string; uses?: string; with?: Record<string, string> }[]
        }
        const readWorkflow = async (name: string) =>
            parseYaml(await readProjectFile(`.github/workflows/${name}.yml`)) as { jobs: Record<string, Job> }
        const main = await readWorkflow("test-main")
        expect(Object.keys(main.jobs)).toEqual(["checks"])
        expect(main.jobs.checks.uses).toBe("./.github/workflows/checks.yml")
        const checks = await readWorkflow("checks")
        expect(Object.keys(checks.jobs).sort()).toEqual(["biome", "smoke", "typecheck", "vitest"])
        const release = await readWorkflow("release")
        for (const [packageId, workId] of [
            ["package", "e2e"],
            ["package-marketplace", "e2e-marketplace"],
        ]) {
            expect(release.jobs[packageId].needs).toBe("verify-tag")
            expect(release.jobs[workId].needs).toBe(packageId)
            expect(release.jobs[workId].with?.artifact_name).toBe(`\${{ needs.${packageId}.outputs.artifact_name }}`)
            expect(release.jobs[workId].with?.commit_sha).toBe(`\${{ needs.${packageId}.outputs.commit_sha }}`)
        }
        const e2e = await readWorkflow("e2e")
        for (const job of Object.values(e2e.jobs)) {
            const downloads = job.steps?.filter((step) => step.uses?.startsWith("actions/download-artifact@")) ?? []
            for (const download of downloads) expect(download.with?.name).toBe("${{ inputs.artifact_name }}")
        }
        const steps = release.jobs["functional-e2e"].steps ?? []
        const build = steps.findIndex((step) => step.run === "npm run e2e:bundle")
        const download = steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@"))
        expect(build).toBeGreaterThan(-1)
        expect(download).toBeGreaterThan(build)
        expect(release.jobs["functional-e2e"].needs).toEqual([
            "verify-tag",
            "package",
            "package-marketplace",
            "e2e",
            "e2e-marketplace",
        ])
        expect(release.jobs.publish.needs).toEqual([
            "verify-tag",
            "package",
            "package-marketplace",
            "e2e",
            "e2e-marketplace",
            "functional-e2e",
        ])
    })

    it("shards the release functional gate across every functional folder", async () => {
        const releaseWorkflow = await readProjectFile(".github/workflows/release.yml")
        const functionalRoot = path.join(PROJECT_ROOT, "src/test/e2e/functional")
        const folders = (await fs.readdir(functionalRoot, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()

        // A folder missing from the matrix would silently drop its tests from the release gate.
        const matrixLine = releaseWorkflow.match(/^\s*folder: \[([^\]]+)\]\s*$/m)
        expect(matrixLine).not.toBeNull()
        const matrixFolders = (matrixLine?.[1] ?? "")
            .split(",")
            .map((folder) => folder.trim())
            .sort()
        expect(matrixFolders).toEqual(folders)
        expect(releaseWorkflow).toContain("fail-fast: false")
        expect(releaseWorkflow).toContain(
            'npx playwright test -c playwright.functional.config.ts "src/test/e2e/functional/${FUNCTIONAL_FOLDER}/" --project "functional e2e tests"',
        )
        expect(releaseWorkflow).toContain(
            "name: playwright-functional-production-${{ matrix.registry }}-${{ matrix.folder }}-ubuntu-${{ github.sha }}",
        )
    })

    it("never places a positional test filter after the variadic Playwright --project option", async () => {
        const workflowDir = path.join(PROJECT_ROOT, ".github/workflows")
        const workflowFiles = (await fs.readdir(workflowDir)).filter((name) => name.endsWith(".yml"))
        // `--project <name...>` consumes every following non-option token, so a path written after it
        // becomes a second project name and Playwright aborts before running a single test.
        // The project name is one quoted or bare token; capture the first character of the token after it.
        const tokenAfterProject = /--project\s+(?:"[^"]*"|[^\s"]+)\s+(\S)/
        const offending: string[] = []
        for (const name of workflowFiles) {
            const content = await readProjectFile(`.github/workflows/${name}`)
            for (const line of content.split("\n")) {
                if (!line.includes("playwright test")) continue
                const nextTokenStart = line.match(tokenAfterProject)?.[1]
                if (nextTokenStart !== undefined && nextTokenStart !== "-") {
                    offending.push(`${name}: ${line.trim()}`)
                }
            }
        }
        expect(offending).toEqual([])
    })

    it("serializes builds against concurrent runs of the shared dist output", async () => {
        const packageJson = JSON.parse(await readProjectFile("package.json")) as RootPackageJson
        const scripts = packageJson.scripts ?? {}

        // dist/ is the one piece of E2E state that is not run-scoped, so every
        // script that writes it must take the exclusive side and every script that
        // reads it must take the shared side.
        expect(scripts["pree2e"]).toContain("--exclusive")
        expect(scripts["test:e2e:build"]).toContain("--exclusive")
        for (const scriptName of ["e2e", "e2e:smoke", "e2e:work", "e2e:functional", "e2e:dev", "e2e:pressure", "e2e:demo"]) {
            expect(scripts[scriptName], `${scriptName} must take the shared dist lock`).toContain("--shared")
        }

        // A packaged tier must not also rebuild through pree2e; the VSIX build and
        // the bundle build would each claim dist/ and deadlock the other.
        for (const scriptName of ["test:e2e", "test:e2e:optimal", "test:e2e:pressure"]) {
            expect(scripts[scriptName], `${scriptName} must build the VSIX once`).toContain("npm run test:e2e:build")
            expect(scripts[scriptName], `${scriptName} must not chain a tier rebuild`).not.toMatch(
                /npm run e2e:(work|functional)\b/,
            )
        }

        // Source-mode tiers intentionally reuse the pree2e bundle instead of
        // packaging a VSIX that their fixture would never install.
        for (const scriptName of ["test:e2e:work", "test:e2e:functional"]) {
            expect(scripts[scriptName], `${scriptName} must not package an unused VSIX`).not.toContain("test:e2e:build")
            expect(scripts[scriptName]).toContain("npm run e2e:prepare")
        }

        const lockRunner = await readProjectFile("scripts/with-dist-lock.mjs")
        expect(lockRunner).toContain("acquireDistLock")

        // The lock lives inside dist/, which vsce packages verbatim.
        expect(await readProjectFile(".vscodeignore")).toContain("dist/.e2e-lock/")
    })

    it("disables dependency scanning in every extension packaging entry point", async () => {
        const packageJson = JSON.parse(await readProjectFile("package.json")) as RootPackageJson
        expect(packageJson.scripts?.["test:e2e:build"]).toContain("--no-dependencies")

        const packageDev = await readProjectFile("scripts/package-dev.mjs")
        const packageVsix = await readProjectFile("scripts/package-vsix.mjs")
        const packageAdapter = await readProjectFile("scripts/vsix-packager.mjs")
        expect(packageDev).toContain('mode: "pack-only"')
        expect(packageVsix).toContain('mode: "build-and-pack"')
        expect(packageAdapter).toMatch(/dependencies:\s*false/)
        expect(packageAdapter).toContain("execFileSync(process.execPath")
        expectDirectVsceCommandsToDisableDependencyScanning(packageVsix, "scripts/package-vsix.mjs")

        const publishInsiders = await readProjectFile("scripts/publish-insiders.mjs")
        expect(publishInsiders).toContain('"--no-dependencies"')
        expect(publishInsiders).not.toMatch(/WorkspaceSelfLink|workspace self-link/i)

        const publishMarketplace = await readProjectFile("scripts/publish-marketplace.mjs")
        expect(publishMarketplace).toContain('"--no-dependencies"')

        const workflowNames = (await fs.readdir(path.join(PROJECT_ROOT, ".github", "workflows")))
            .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
            .sort()
        for (const workflowName of workflowNames) {
            const workflowPath = `.github/workflows/${workflowName}`
            expectDirectVsceCommandsToDisableDependencyScanning(await readProjectFile(workflowPath), workflowPath)
        }
    })
})
