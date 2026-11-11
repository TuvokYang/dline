import assert from "node:assert/strict"
import test from "node:test"
import { assertMainChecks, assertTagHead, awaitMainGate, resolveMainGate } from "./main-gate.mjs"

const sha = "a".repeat(40)
const context = { repository: "example/project", sha }
const run = {
    id: 10,
    run_attempt: 1,
    path: ".github/workflows/test-main.yml",
    event: "push",
    head_branch: "main",
    head_sha: sha,
    head_repository: { full_name: context.repository },
    status: "completed",
    conclusion: "success",
}
const jobs = [
    "TypeScript",
    "Biome",
    "Smoke",
    ...["backend-task", "backend-prompts", "backend-hooks", "backend-core", "backend", "webview"].map(
        (project) => `Vitest (${project})`,
    ),
].map((name) => ({ name: `Main source checks / ${name}`, conclusion: "success" }))

test("production reuses only an exact successful main push, not dev or a tag's old Tests", () => {
    assert.deepEqual(resolveMainGate([run], context), { status: "ready", id: 10, attempt: 1 })
    for (const invalid of [
        { path: ".github/workflows/test.yml" },
        { event: "pull_request" },
        { head_branch: "dev" },
        { head_sha: "b".repeat(40) },
        { head_repository: { full_name: "fork/project" } },
    ]) {
        assert.deepEqual(resolveMainGate([{ ...run, ...invalid }], context), { status: "waiting" })
    }
})

test("a newer failed or running main run cannot be hidden by older success", () => {
    for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"]) {
        assert.throws(() => resolveMainGate([run, { ...run, id: 11, conclusion }], context), /blocked/)
    }
    assert.deepEqual(resolveMainGate([run, { ...run, id: 11, status: "in_progress", conclusion: null }], context), {
        status: "waiting",
    })
    assert.throws(() => resolveMainGate([{ ...run, run_attempt: 0 }], context), /identity/)
})

test("every base check must succeed; skipped, missing and duplicate results are not success", () => {
    assertMainChecks(jobs)
    for (let index = 0; index < jobs.length; index++) {
        assert.throws(() => assertMainChecks(jobs.filter((_, at) => at !== index)), /successful result/)
        assert.throws(
            () => assertMainChecks(jobs.map((job, at) => (at === index ? { ...job, conclusion: "skipped" } : job))),
            /successful result/,
        )
        assert.throws(() => assertMainChecks([...jobs, jobs[index]]), /successful result/)
    }
})

test("tag arriving before Main Tests completes waits for that run without starting any workflow", async () => {
    const seen = []
    const states = [[], [{ ...run, status: "in_progress" }], [run]]
    const gate = await awaitMainGate(
        context,
        {
            listRuns: async () => states.shift(),
            listJobs: async (gate) => {
                seen.push(gate)
                return jobs
            },
            pause: async () => {
                seen.push("wait")
            },
        },
        3,
    )
    assert.deepEqual(seen, ["wait", "wait", { status: "ready", id: 10, attempt: 1 }])
    assert.equal(gate.id, 10)
})

test("tag arriving after Main Tests succeeds reuses immediately", async () => {
    const gate = await awaitMainGate(context, {
        listRuns: async () => [run],
        listJobs: async () => jobs,
        pause: async () => assert.fail("must not wait"),
    })
    assert.equal(gate.id, run.id)
})

test("missing evidence times out and API failures propagate instead of dispatching replacement checks", async () => {
    let waits = 0
    await assert.rejects(awaitMainGate(context, { listRuns: async () => [], pause: async () => waits++ }, 2), /Timed out/)
    assert.equal(waits, 1)
    await assert.rejects(
        awaitMainGate(context, {
            listRuns: async () => {
                throw new Error("API unavailable")
            },
        }),
        /API unavailable/,
    )
})

test("only a production tag at the current exact main SHA admits production E2E", () => {
    const valid = { tag: "v2.4.0", sha, main: sha, tagged: sha }
    assertTagHead(valid)
    for (const invalid of [
        { tag: "dev-v2.5.0" },
        { tag: "v2.5.0" },
        { tag: "v2.4.0-extra" },
        { main: "b".repeat(40) },
        { tagged: "b".repeat(40) },
        { sha: "short" },
    ])
        assert.throws(() => assertTagHead({ ...valid, ...invalid }))
})
