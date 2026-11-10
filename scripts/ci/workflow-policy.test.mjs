import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import yaml from "js-yaml"
import { hasTestedPackages, isReusedTestRun, resolveTestExecution } from "./workflow-policy.mjs"

const before = "a".repeat(40)
const head = "b".repeat(40)
const main = "c".repeat(40)
const tree = "d".repeat(40)
const repository = "example/project"
const successfulRun = {
    id: 123,
    path: ".github/workflows/test.yml",
    event: "push",
    head_branch: "dev",
    head_sha: before,
    head_repository: { full_name: repository },
    status: "completed",
    conclusion: "success",
}
const packages = (sha = before) => [
    { name: `dline-vsix-${sha}`, expired: false, size_in_bytes: 100 },
    { name: `dline-vscode-marketplace-vsix-${sha}`, expired: false, size_in_bytes: 200 },
]
const push = { event: "push", ref: "refs/heads/dev", sha: head, before, repository }

function fixture({
    current = { tree, parents: [before, main] },
    previous = { tree, parents: [] },
    runs = [successfulRun],
    artifacts = packages(),
} = {}) {
    const requests = []
    return {
        requests,
        readCommit: (sha) => {
            requests.push(["commit", sha])
            return sha === head ? current : previous
        },
        readDevHead: () => before,
        listRuns: (sha) => {
            requests.push(["runs", sha])
            return runs
        },
        listArtifacts: (id) => {
            requests.push(["artifacts", id])
            return artifacts
        },
    }
}

test("a content-preserving dev back-merge reuses the exact previous successful gate", async () => {
    const ports = fixture()
    const result = await resolveTestExecution(push, ports)
    assert.equal(result.run_tests, "false")
    assert.equal(result.reused_run_id, "123")
    assert.deepEqual(ports.requests, [
        ["commit", head],
        ["commit", before],
        ["runs", before],
        ["artifacts", 123],
    ])
})

for (const [name, context] of [
    ["PR", { event: "pull_request", ref: "refs/pull/3/merge" }],
    ["production tag", { ref: "refs/tags/v2.4.0" }],
    ["pre-release tag", { ref: "refs/tags/dev-v2.5.0" }],
    ["manual validation", { event: "workflow_dispatch" }],
    ["missing previous commit", { before: undefined }],
    ["new branch", { before: "0".repeat(40) }],
]) {
    test(`${name} never inherits a dev gate`, async () => {
        const ports = fixture()
        assert.equal((await resolveTestExecution({ ...push, ...context }, ports)).run_tests, "true")
        assert.deepEqual(ports.requests, [])
    })
}

for (const [name, current] of [
    ["ordinary commit", { tree, parents: [before] }],
    ["different first parent", { tree, parents: [main, before] }],
    ["changed merge", { tree: "e".repeat(40), parents: [before, main] }],
]) {
    test(`${name} requires tests`, async () => {
        const ports = fixture({ current })
        assert.equal((await resolveTestExecution(push, ports)).run_tests, "true")
        assert.equal(
            ports.requests.some(([kind]) => kind === "runs"),
            false,
        )
    })
}

for (const [name, overrides] of [
    ["failed", { conclusion: "failure" }],
    ["cancelled", { conclusion: "cancelled" }],
    ["running", { status: "in_progress", conclusion: null }],
    ["fork", { head_repository: { full_name: "other/project" } }],
    ["PR", { event: "pull_request" }],
    ["other workflow", { path: ".github/workflows/other.yml" }],
    ["other commit", { head_sha: main }],
    ["other branch", { head_branch: "feature/work" }],
]) {
    test(`a ${name} run cannot justify skipping`, async () => {
        assert.equal(
            (await resolveTestExecution(push, fixture({ runs: [{ ...successfulRun, ...overrides }] }))).run_tests,
            "true",
        )
    })
}

test("a newer failure or in-progress run cannot be hidden by an older success", async () => {
    for (const latest of [{ conclusion: "failure" }, { status: "in_progress", conclusion: null }]) {
        const runs = [successfulRun, { ...successfulRun, id: 124, ...latest }]
        assert.equal((await resolveTestExecution(push, fixture({ runs }))).run_tests, "true")
    }
})

for (const [name, artifacts] of [
    ["no artifacts", []],
    ["one publisher", packages().slice(0, 1)],
    ["expired package", packages().map((artifact, index) => ({ ...artifact, expired: index === 1 }))],
    ["empty package", packages().map((artifact, index) => ({ ...artifact, size_in_bytes: index === 1 ? 0 : 100 }))],
    ["wrong commit", packages(main)],
]) {
    test(`${name} cannot justify skipping`, async () => {
        assert.equal(hasTestedPackages(artifacts, before), false)
        assert.equal((await resolveTestExecution(push, fixture({ artifacts }))).run_tests, "true")
    })
}

test("failed provenance retrieval fails the gate rather than skipping tests", async () => {
    const ports = fixture()
    ports.listRuns = () => {
        throw new Error("API unavailable")
    }
    await assert.rejects(resolveTestExecution(push, ports), /API unavailable/)
})

test("main still enters Tests and reuses only a verified identical dev tree", async () => {
    const context = { ...push, ref: "refs/heads/main", before: main }
    const ports = fixture({ current: { tree, parents: [main] } })
    const result = await resolveTestExecution(context, ports)
    assert.equal(result.run_tests, "false")
    assert.equal(result.reused_run_id, "123")
    for (const options of [
        { current: { tree, parents: [main] }, previous: { tree: "e".repeat(40) } },
        { current: { tree, parents: [main] }, runs: [] },
        { current: { tree, parents: [main] }, runs: [{ ...successfulRun, conclusion: "failure" }] },
        { current: { tree, parents: [before, main] } },
    ]) {
        assert.equal((await resolveTestExecution(context, fixture(options))).run_tests, "true")
    }
})

const reuseOnlyJobs = [
    { name: "Resolve test execution", conclusion: "success" },
    { name: "TypeScript", conclusion: "skipped" },
    { name: "Package VSIX", conclusion: "skipped" },
    { name: "E2E", conclusion: "skipped" },
]

test("only a successful reuse-only gate suppresses duplicate Insiders publication", () => {
    assert.equal(isReusedTestRun(reuseOnlyJobs), true)
    for (const jobs of [
        [],
        reuseOnlyJobs.slice(1),
        reuseOnlyJobs.filter((job) => job.name !== "TypeScript"),
        reuseOnlyJobs.map((job) => ({ ...job, conclusion: "success" })),
        reuseOnlyJobs.map((job) => (job.name === "TypeScript" ? { ...job, conclusion: "failure" } : job)),
        reuseOnlyJobs.map((job) => (job.name === "Resolve test execution" ? { ...job, conclusion: "failure" } : job)),
        [...reuseOnlyJobs, { name: "Vitest", conclusion: "success" }],
    ]) {
        assert.equal(isReusedTestRun(jobs), false)
    }
})

const workflow = (name) => yaml.load(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"))

test("main and dev retain Tests while the production tag retains every release gate", () => {
    const tests = workflow("test")
    assert.deepEqual(tests.on.push.branches, ["main", "dev"])
    assert.deepEqual(tests.on.pull_request.branches, ["main", "dev"])
    assert.equal(tests.jobs.policy.name, "Resolve test execution")
    assert.equal(tests.jobs.typecheck.name, "TypeScript")
    assert.ok(tests.on.workflow_call)
    assert.equal(tests.jobs.typecheck.needs, "policy")
    assert.equal(tests.jobs.typecheck.if, "needs.policy.outputs.run_tests == 'true'")
    for (const job of ["biome", "smoke", "vitest", "package", "package-marketplace", "e2e", "e2e-marketplace"]) {
        assert.ok(tests.jobs[job].needs, `${job} must remain downstream of the gate`)
        assert.equal(tests.jobs[job].if, undefined)
    }
    const release = workflow("release")
    assert.deepEqual(release.on.push.tags, ["v*"])
    assert.equal(release.jobs.tests.uses, "./.github/workflows/test.yml")
    assert.equal(release.jobs.tests.with.package_profile, "release")
    assert.equal(release.jobs.tests.with.package_channel, "production")
    assert.deepEqual(release.jobs["functional-e2e"].strategy.matrix.registry, ["open-vsx", "vscode-marketplace"])
    assert.deepEqual(release.jobs.publish.needs, ["verify-tag", "tests", "functional-e2e"])
})

test("normal successful dev Tests still automatically publish their tested Insiders artifacts", () => {
    const insiders = workflow("publish-insiders")
    assert.deepEqual(Object.keys(insiders.on), ["workflow_run"])
    assert.deepEqual(insiders.on.workflow_run, { workflows: ["Tests"], types: ["completed"] })
    const verify = insiders.jobs["verify-insiders"]
    const condition = verify.if.replace(/\s+/g, " ").trim()
    assert.equal(
        condition,
        "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'dev'",
    )
    const downloads = verify.steps.filter((step) => step.uses?.startsWith("actions/download-artifact@"))
    assert.equal(downloads.length, 2)
    for (const download of downloads) {
        assert.equal(download.with["run-id"], "${{ github.event.workflow_run.id }}")
        assert.equal(download.if, "steps.trigger.outputs.eligible == 'true'")
    }
    for (const job of ["publish-draft", "publish-registries"]) {
        assert.equal(insiders.jobs[job].if, "needs.verify-insiders.outputs.eligible == 'true'")
    }
    const registries = workflow("publish-vsix-registries")
    assert.equal(registries.on.workflow_call.inputs.tests_run_id, undefined)
})
