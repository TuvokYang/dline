import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { load as parseYaml } from "js-yaml"
import { parse as parseCommand } from "shell-quote"
import { describe, expect, it } from "vitest"

interface WorkflowStep {
    run?: string
    uses?: string
    with?: Record<string, string>
    env?: Record<string, string>
}

interface WorkflowJob {
    uses?: string
    needs?: string | string[]
    with?: Record<string, string>
    outputs?: Record<string, string>
    environment?: string | { name: string }
    steps?: WorkflowStep[]
    strategy?: { matrix: Record<string, unknown> }
}

interface Workflow {
    on: {
        workflow_call?: {
            inputs?: Record<string, { required?: boolean; default?: unknown }>
            outputs?: Record<string, { value: string }>
        }
    }
    jobs: Record<string, WorkflowJob>
}

const WORKFLOW_NAMES = [
    "package.yml",
    "test.yml",
    "test-main.yml",
    "checks.yml",
    "e2e.yml",
    "publish-insiders.yml",
    "release-draft.yml",
    "release.yml",
    "publish-production-release.yml",
    "publish-vscode-marketplace.yml",
    "publish-vsix-registries.yml",
]

async function readWorkflow(name: string): Promise<Workflow> {
    return parseYaml(await fs.readFile(path.join(process.cwd(), ".github/workflows", name), "utf8")) as Workflow
}

function actionStep(job: WorkflowJob, action: string): WorkflowStep {
    const step = job.steps?.find((candidate) => candidate.uses?.startsWith(`${action}@`))
    if (!step) throw new Error(`Missing action ${action}`)
    return step
}

function dependencies(job: WorkflowJob): string[] {
    return typeof job.needs === "string" ? [job.needs] : (job.needs ?? [])
}

function resolveBash(): string {
    if (process.platform !== "win32") return "bash"
    let directory = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim()
    while (path.dirname(directory) !== directory) {
        const candidate = path.join(directory, "bin", "bash.exe")
        if (existsSync(candidate)) return candidate
        directory = path.dirname(directory)
    }
    throw new Error("Git Bash is required to exercise the packaging workflow on Windows")
}

/**
 * Which CLI surface the checked-out packaging script exposes.
 *
 * A release tag checked out by the manual override carries its own script, so
 * the workflow must cope with every historical shape. Each value below mirrors
 * the real arg parser of that ref, not a simulated `--help` string.
 */
type PackagerCli = "current" | "publisher-only" | "legacy"

const PACKAGER_SUPPORTED_FLAGS: Record<PackagerCli, string[]> = {
    current: ["--channel", "--out", "--publisher", "--registry", "--help"],
    "publisher-only": ["--channel", "--out", "--publisher", "--help"],
    legacy: ["--channel", "--out", "--help"],
}

const PACKAGER_USAGE: Record<PackagerCli, string> = {
    current: "Usage: npm run vsix -- [--channel <channel>] [--out <path>] [--publisher <id>] [--registry <registry>]",
    "publisher-only": "Usage: npm run vsix -- [--channel <channel>] [--out <path>] [--publisher <id>]",
    legacy: "Usage: npm run vsix -- [--channel <channel>] [--out <path>]",
}

describe("Marketplace publisher delivery", () => {
    it.each([
        ["package-ci", "ci", "vscode-marketplace", "current"],
        ["package-ci", "ci", "open-vsx", "current"],
        ["package-release", "production", "vscode-marketplace", "current"],
        ["package-release", "production", "open-vsx", "current"],
        // Historical refs: the manual override checks out a release tag and
        // therefore runs that tag's own packaging script.
        ["package-release", "production", "open-vsx", "publisher-only"],
        ["package-release", "production", "open-vsx", "legacy"],
    ] as [
        string,
        string,
        string,
        PackagerCli,
    ][])("builds %s for %s/%s with a %s packaging CLI", async (jobId, channel, registry, packagerCli) => {
        const workflow = await readWorkflow("package.yml")
        const step = workflow.jobs[jobId].steps?.find((candidate) => candidate.env?.DLINE_ENVIRONMENT === "production")
        if (!step?.run) throw new Error(`Missing build step for ${jobId}`)
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-publisher-workflow-"))
        const original = JSON.stringify({
            name: "historical-package-fixture",
            version: "0.12.2",
            publisher: "tuvokyang",
            private: true,
            scripts: { vsix: "node capture.mjs" },
        })
        try {
            await fs.writeFile(path.join(directory, "package.json"), original)
            await fs.writeFile(
                path.join(directory, "capture.mjs"),
                [
                    'import fs from "node:fs";',
                    'const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));',
                    'fs.writeFileSync("observed.json", JSON.stringify({publisher: manifest.publisher, args: process.argv.slice(2)}));',
                    "process.exit(0);",
                ].join("\n"),
            )
            // Mirror the checked-out script's real arg parser, so a flag the
            // historical ref never accepted fails here exactly as it does in CI.
            await fs.mkdir(path.join(directory, "scripts"), { recursive: true })
            await fs.writeFile(
                path.join(directory, "scripts", "package-vsix.mjs"),
                [
                    "const supported = new Set(JSON.parse(process.env.FIXTURE_PACKAGER_FLAGS));",
                    "const argv = process.argv.slice(2);",
                    "for (let index = 0; index < argv.length; index += 1) {",
                    "    const argument = argv[index];",
                    '    if (!supported.has(argument)) { console.log("Unknown argument \'" + argument + "\'."); process.exit(1); }',
                    '    if (argument === "--help") { console.log(process.env.FIXTURE_PACKAGER_USAGE); process.exit(0); }',
                    "    index += 1;",
                    "}",
                    "process.exit(0);",
                ].join("\n"),
            )
            const result = spawnSync(
                resolveBash(),
                ["--noprofile", "--norc", "-c", step.run.replaceAll("${{ steps.package.outputs.filename }}", "test.vsix")],
                {
                    cwd: directory,
                    encoding: "utf8",
                    timeout: 30_000,
                    env: {
                        ...process.env,
                        CHANNEL: channel,
                        VSIX_REGISTRY: registry,
                        RUNNER_TEMP: directory.replaceAll("\\", "/"),
                        FIXTURE_PACKAGER_FLAGS: JSON.stringify(PACKAGER_SUPPORTED_FLAGS[packagerCli]),
                        // The fixture packager accepts every forwarded argument,
                        // so it always votes success; workflow-level exit codes
                        // are covered by the rejection cases below.
                        FIXTURE_PACKAGER_USAGE: PACKAGER_USAGE[packagerCli],
                    },
                },
            )
            expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined()
            expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
            const observed = JSON.parse(await fs.readFile(path.join(directory, "observed.json"), "utf8"))
            // The workflow never rewrites package.json itself; registry-specific
            // identity is resolved inside the packaging script.
            expect(observed).toEqual({
                publisher: "tuvokyang",
                args: [
                    "--channel",
                    channel,
                    ...(packagerCli === "current" ? ["--registry", registry] : []),
                    "--out",
                    "dist/test.vsix",
                ],
            })
            expect(await fs.readFile(path.join(directory, "package.json"), "utf8")).toBe(original)
        } finally {
            await fs.rm(directory, { recursive: true, force: true })
        }
    })

    // A ref without --registry can only emit the globally taken name 'dline',
    // so the workflow must refuse instead of publishing a colliding identity
    // or silently reverting the publisher-specific package.
    it.each([
        "publisher-only",
        "legacy",
    ] as PackagerCli[])("refuses a %s packaging CLI for the VS Code Marketplace", async (packagerCli) => {
        const workflow = await readWorkflow("package.yml")
        const step = workflow.jobs["package-release"].steps?.find(
            (candidate) => candidate.env?.DLINE_ENVIRONMENT === "production",
        )
        if (!step?.run) throw new Error("Missing package-release build step")
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-publisher-workflow-"))
        try {
            await fs.writeFile(
                path.join(directory, "package.json"),
                JSON.stringify({
                    name: "historical-package-fixture",
                    version: "0.12.2",
                    publisher: "tuvokyang",
                    private: true,
                    scripts: { vsix: "node capture.mjs" },
                }),
            )
            await fs.writeFile(
                path.join(directory, "capture.mjs"),
                'import fs from "node:fs";\nfs.writeFileSync("observed.json", "[]");\nprocess.exit(0);',
            )
            await fs.mkdir(path.join(directory, "scripts"), { recursive: true })
            await fs.writeFile(
                path.join(directory, "scripts", "package-vsix.mjs"),
                [
                    "const supported = new Set(JSON.parse(process.env.FIXTURE_PACKAGER_FLAGS));",
                    "const argv = process.argv.slice(2);",
                    "for (let index = 0; index < argv.length; index += 1) {",
                    "    const argument = argv[index];",
                    '    if (!supported.has(argument)) { console.log("Unknown argument \'" + argument + "\'."); process.exit(1); }',
                    '    if (argument === "--help") { console.log(process.env.FIXTURE_PACKAGER_USAGE); process.exit(0); }',
                    "    index += 1;",
                    "}",
                    "process.exit(0);",
                ].join("\n"),
            )
            const result = spawnSync(
                resolveBash(),
                ["--noprofile", "--norc", "-c", step.run.replaceAll("${{ steps.package.outputs.filename }}", "test.vsix")],
                {
                    cwd: directory,
                    encoding: "utf8",
                    timeout: 30_000,
                    env: {
                        ...process.env,
                        CHANNEL: "production",
                        VSIX_REGISTRY: "vscode-marketplace",
                        RUNNER_TEMP: directory.replaceAll("\\", "/"),
                        FIXTURE_PACKAGER_FLAGS: JSON.stringify(PACKAGER_SUPPORTED_FLAGS[packagerCli]),
                        FIXTURE_PACKAGER_USAGE: PACKAGER_USAGE[packagerCli],
                    },
                },
            )
            expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0)
            expect(result.stdout).toContain("predates --registry")
            // The rejected run must not have packaged anything.
            expect(existsSync(path.join(directory, "observed.json"))).toBe(false)
        } finally {
            await fs.rm(directory, { recursive: true, force: true })
        }
    })

    it("provides a packaging-only command without changing the Open VSX source publisher", async () => {
        const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
            publisher: string
            scripts: Record<string, string>
        }

        expect(pkg.publisher).toBe("tuvokyang")
        expect(parseCommand(pkg.scripts["vsix:vscode-marketplace"])).toEqual([
            "node",
            "scripts/package-vsix.mjs",
            "--registry",
            "vscode-marketplace",
            "--publisher",
            "tuvokyangdline",
        ])
        expect(parseCommand(pkg.scripts.vsix)).toEqual(["node", "scripts/package-vsix.mjs"])
    })

    it("preserves every required reusable-workflow input at its real call sites", async () => {
        const workflows = new Map(
            await Promise.all(WORKFLOW_NAMES.map(async (name) => [name, await readWorkflow(name)] as const)),
        )

        for (const [callerName, workflow] of workflows) {
            for (const [jobId, job] of Object.entries(workflow.jobs)) {
                if (!job.uses?.startsWith("./.github/workflows/")) continue
                const callee = workflows.get(path.posix.basename(job.uses))
                expect(callee, `${callerName}/${jobId} must reference a known workflow`).toBeDefined()
                const inputs = callee?.on.workflow_call?.inputs ?? {}
                const supplied = job.with ?? {}
                for (const key of Object.keys(supplied)) {
                    expect(inputs, `${callerName}/${jobId} supplies unknown input ${key}`).toHaveProperty(key)
                }
                for (const [key, definition] of Object.entries(inputs)) {
                    if (definition.required) {
                        expect(supplied[key], `${callerName}/${jobId} must supply ${key}`).toBeTruthy()
                    }
                }
            }
        }
    })

    it("tests each registry's own final package rather than reusing the other publisher's VSIX", async () => {
        const workflow = await readWorkflow("test.yml")
        const original = workflow.jobs.package
        const marketplace = workflow.jobs["package-marketplace"]
        expect(dependencies(original)).toEqual(["checks"])
        expect(dependencies(marketplace)).toEqual(["checks"])
        expect(marketplace.uses).toBe(original.uses)
        expect(marketplace.with).toMatchObject({
            profile: "${{ inputs.package_profile || 'ci' }}",
            channel:
                "${{ inputs.package_channel && inputs.package_channel != 'auto' && inputs.package_channel || (github.event_name == 'push' && github.ref == 'refs/heads/dev' && 'insiders' || 'ci') }}",
            registry: "vscode-marketplace",
        })
        expect(original.with?.registry).toBeUndefined()

        for (const [jobId, packageId, registry] of [
            ["e2e", "package", undefined],
            ["e2e-marketplace", "package-marketplace", "vscode-marketplace"],
        ] as const) {
            const job = workflow.jobs[jobId]
            expect(dependencies(job)).toEqual([packageId])
            expect(job.uses).toBe("./.github/workflows/e2e.yml")
            expect(job.with?.registry).toBe(registry)
            expect(job.with?.artifact_name).toBe(`\${{ needs.${packageId}.outputs.artifact_name }}`)
            expect(job.with?.commit_sha).toBe(`\${{ needs.${packageId}.outputs.commit_sha }}`)
        }

        expect(workflow.on.workflow_call?.outputs?.marketplace_artifact_name.value).toBe(
            "${{ jobs.package-marketplace.outputs.artifact_name }}",
        )
        expect(workflow.on.workflow_call?.outputs?.marketplace_sha256.value).toBe(
            "${{ jobs.package-marketplace.outputs.sha256 }}",
        )
    })

    it("keeps the complete work and functional gates for both publisher builds", async () => {
        const e2e = await readWorkflow("e2e.yml")
        expect(e2e.jobs["work-daily"].needs).toBe("work-smoke")
        expect(e2e.jobs["work-daily"].strategy?.matrix.runner).toEqual(["ubuntu", "windows", "macos"])
        expect(e2e.jobs["work-daily"].strategy?.matrix.shard).toHaveLength(4)

        const release = await readWorkflow("release.yml")
        expect(release.jobs["functional-e2e"].strategy?.matrix.registry).toEqual(["open-vsx", "vscode-marketplace"])
        expect(dependencies(release.jobs.publish)).toEqual([
            "verify-tag",
            "package",
            "package-marketplace",
            "e2e",
            "e2e-marketplace",
            "functional-e2e",
        ])
        expect(release.jobs.publish.with?.marketplace_expected_sha256).toBe("${{ needs.package-marketplace.outputs.sha256 }}")
        for (const [packageId, workId, registry] of [
            ["package", "e2e", undefined],
            ["package-marketplace", "e2e-marketplace", "vscode-marketplace"],
        ] as const) {
            expect(release.jobs[packageId].with).toMatchObject({ profile: "release", channel: "production" })
            expect(release.jobs[packageId].with?.registry).toBe(registry)
            expect(dependencies(release.jobs[workId])).toEqual([packageId])
            expect(release.jobs[workId].with?.artifact_name).toBe(`\${{ needs.${packageId}.outputs.artifact_name }}`)
        }
        const prerelease = await readWorkflow("release-draft.yml")
        expect(dependencies(prerelease.jobs["publish-pre-release-registry"])).toEqual(["verify-tag", "tests", "release"])
        expect(prerelease.jobs["publish-pre-release-registry"].with?.marketplace_expected_sha256).toBe(
            "${{ needs.tests.outputs.marketplace_sha256 }}",
        )
    })

    it("retrieves both Insiders packages from the exact successful Tests run", async () => {
        const workflow = await readWorkflow("publish-insiders.yml")
        const verification = workflow.jobs["verify-insiders"]
        const downloads = verification.steps?.filter((step) => step.uses?.startsWith("actions/download-artifact@")) ?? []
        expect(downloads.map((step) => step.with?.name)).toEqual([
            "dline-vsix-${{ github.event.workflow_run.head_sha }}",
            "dline-vscode-marketplace-vsix-${{ github.event.workflow_run.head_sha }}",
        ])
        for (const step of downloads) {
            expect(step.with?.["run-id"]).toBe("${{ github.event.workflow_run.id }}")
        }
        const publisher = workflow.jobs["publish-registries"]
        expect(dependencies(publisher)).toEqual(["verify-insiders"])
        expect(publisher.with?.marketplace_asset_name).toBe("${{ needs.verify-insiders.outputs.marketplace_asset_name }}")
        expect(publisher.with?.marketplace_expected_sha256).toBe("${{ needs.verify-insiders.outputs.marketplace_sha256 }}")
    })

    it("enables Marketplace publishing with its own artifact, digest and existing environment credential", async () => {
        const workflow = await readWorkflow("publish-vsix-registries.yml")
        expect(workflow.on.workflow_call?.inputs?.publish_marketplace.default).toBe(true)
        const marketplace = workflow.jobs["publish-marketplace"]
        const openVsx = workflow.jobs["publish-open-vsx"]
        expect(marketplace.needs).toBe("verify-source")
        expect(openVsx.needs).toBe("verify-source")
        expect(actionStep(marketplace, "actions/download-artifact").with?.name).toBe("${{ inputs.marketplace_artifact_name }}")
        expect(actionStep(openVsx, "actions/download-artifact").with?.name).toBe("${{ inputs.artifact_name }}")
        expect(marketplace.environment).toEqual({ name: "dline-release" })
        const publishing = marketplace.steps?.find((step) => step.env?.VSCE_PAT)
        expect(publishing?.env).toMatchObject({
            VSCE_PAT: "${{ secrets.DLINE_VSCODE_RELEASE_PUBLISH_PAT }}",
            ASSET_NAME: "${{ inputs.marketplace_asset_name }}",
            EXPECTED_SHA256: "${{ inputs.marketplace_expected_sha256 }}",
        })
    })

    it("builds the manual override's Marketplace artifact separately without claiming the automatic test gate", async () => {
        const workflow = await readWorkflow("publish-vscode-marketplace.yml")
        expect(workflow.jobs["package-marketplace"].with).toMatchObject({
            registry: "vscode-marketplace",
            source_ref: "${{ needs.validate.outputs.tag }}",
            artifact_key: "${{ needs.validate.outputs.commit_sha }}",
        })
        expect(dependencies(workflow.jobs.publish)).toEqual(["validate", "package", "package-marketplace"])
        expect(workflow.jobs.publish.with?.marketplace_artifact_name).toBe(
            "${{ needs.package-marketplace.outputs.artifact_name }}",
        )
        expect(workflow.jobs.publish.with?.marketplace_expected_sha256).toBe("${{ needs.package-marketplace.outputs.sha256 }}")
    })
})
