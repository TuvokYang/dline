import assert from "node:assert/strict"
import test from "node:test"
import { assertTestEvidence, awaitTagTests, createTestEvidence, resolveTagTests } from "./production-gate.mjs"

const sha = "a".repeat(40)
const context = { repository: "example/project", sha, tag: "v2.4.0" }
const run = {
    id: 20,
    run_attempt: 2,
    path: ".github/workflows/test-main.yml",
    event: "push",
    head_branch: context.tag,
    head_sha: sha,
    head_repository: { full_name: context.repository },
    status: "completed",
    conclusion: "success",
}
const identity = { ...context, id: 20, attempt: 2 }
const evidence = {
    tag: context.tag,
    version: "2.4.0",
    commit_sha: sha,
    run_id: 20,
    run_attempt: 2,
    packages: {
        "open-vsx": { artifact_name: `dline-vsix-${sha}`, asset_name: "dline-2.4.0.vsix", sha256: "1".repeat(64) },
        "vscode-marketplace": {
            artifact_name: `dline-vscode-marketplace-vsix-${sha}`,
            asset_name: "dline-2.4.0.vsix",
            sha256: "2".repeat(64),
        },
    },
}
const jobs = [{ name: "Record production test evidence", conclusion: "success" }]

test("publication accepts only the exact tagged Main Tests, not ordinary main or another repository", () => {
    assert.deepEqual(resolveTagTests([run], context), { status: "ready", id: 20, attempt: 2 })
    for (const invalid of [
        { head_branch: "main" },
        { head_branch: "v2.4.1" },
        { event: "pull_request" },
        { path: ".github/workflows/release.yml" },
        { head_sha: "b".repeat(40) },
        { head_repository: { full_name: "fork/project" } },
    ])
        assert.deepEqual(resolveTagTests([{ ...run, ...invalid }], context), { status: "waiting" })
})

test("latest failed or pending tag tests cannot fall back to an older success", () => {
    for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"])
        assert.throws(() => resolveTagTests([run, { ...run, id: 21, conclusion }], context), /blocked/)
    assert.deepEqual(resolveTagTests([run, { ...run, id: 21, status: "in_progress" }], context), { status: "waiting" })
    assert.throws(() => resolveTagTests([{ ...run, run_attempt: 0 }], context), /identity/)
})

test("publication waits for tests without starting or packaging anything", async () => {
    const states = [[], [{ ...run, status: "in_progress" }], [run]]
    let waits = 0
    const result = await awaitTagTests(
        context,
        {
            listRuns: async () => states.shift(),
            listJobs: async (gate) => {
                assert.deepEqual(gate, { status: "ready", id: 20, attempt: 2 })
                return jobs
            },
            pause: async () => waits++,
        },
        3,
    )
    assert.equal(result.id, 20)
    assert.equal(waits, 2)
})

test("missing, duplicate or skipped aggregate evidence blocks publication", async () => {
    for (const invalid of [[], [...jobs, ...jobs], [{ ...jobs[0], conclusion: "skipped" }]])
        await assert.rejects(
            awaitTagTests(context, {
                listRuns: async () => [run],
                listJobs: async () => invalid,
                pause: async () => assert.fail("completed evidence must not be retried"),
            }),
            /evidence job/,
        )
})

test("bounded waiting and API errors fail closed", async () => {
    let waits = 0
    await assert.rejects(awaitTagTests(context, { listRuns: async () => [], pause: async () => waits++ }, 2), /Timed out/)
    assert.equal(waits, 1)
    await assert.rejects(
        awaitTagTests(context, {
            listRuns: async () => {
                throw new Error("API unavailable")
            },
        }),
        /API unavailable/,
    )
})

test("evidence binds both hashes to a tag, SHA, run and attempt", () => {
    assert.equal(assertTestEvidence(evidence, identity), evidence)
    for (const invalid of [
        { commit_sha: "b".repeat(40) },
        { tag: "v2.4.1" },
        { version: "2.4.1" },
        { run_id: 19 },
        { run_attempt: 1 },
    ])
        assert.throws(() => assertTestEvidence({ ...evidence, ...invalid }, identity), /does not belong/)
    for (const registry of ["open-vsx", "vscode-marketplace"]) {
        for (const invalid of [{ artifact_name: "different-run" }, { asset_name: "../dline.vsix" }, { sha256: "invalid" }])
            assert.throws(
                () =>
                    assertTestEvidence(
                        {
                            ...evidence,
                            packages: { ...evidence.packages, [registry]: { ...evidence.packages[registry], ...invalid } },
                        },
                        identity,
                    ),
                /Invalid tested package/,
            )
        assert.throws(() => assertTestEvidence({ ...evidence, packages: { [registry]: evidence.packages[registry] } }, identity))
    }
})

test("recorded evidence preserves the two package identities and their distinct digests", () => {
    const result = createTestEvidence({
        RELEASE_TAG: "v2.4.0",
        COMMIT_SHA: sha,
        GITHUB_RUN_ID: "20",
        GITHUB_RUN_ATTEMPT: "2",
        PUBLIC_ARTIFACT: `dline-vsix-${sha}`,
        PUBLIC_ASSET: "dline-2.4.0.vsix",
        PUBLIC_SHA256: "1".repeat(64),
        MARKETPLACE_ARTIFACT: `dline-vscode-marketplace-vsix-${sha}`,
        MARKETPLACE_ASSET: "dline-2.4.0.vsix",
        MARKETPLACE_SHA256: "2".repeat(64),
    })
    assert.deepEqual(result, evidence)
    assert.throws(() => createTestEvidence({ RELEASE_TAG: "dev-v2.5.0", COMMIT_SHA: sha }))
})
