import assert from "node:assert/strict"
import test from "node:test"
import { evaluateTaskGate } from "../lib/gate.mjs"
import { findRecordContradictions } from "../lib/task-model.mjs"

const record = (changes = {}) => ({
    id: "TASK-A",
    status: "active",
    blockers: [],
    waitingFor: [],
    requiredVerification: new Map([["VER-A", { requiredResult: "passed", claim: "delivery and recovery" }]]),
    verification: [
        { check: "VER-A", result: "passed", conclusion: "Delivery and recovery were verified at the owning boundary." },
    ],
    ...changes,
})
const graph = { tasks: [{ id: "TASK-A", dependsOn: [] }] }
const gate = (task) => evaluateTaskGate(task, graph, new Map([[task.id, task]]))

test("checks an implemented active task before completion without mutating its status", () => {
    const task = record()
    assert.equal(gate(task).astAllowed, true)
    assert.equal(gate(task).readyForConformance, true)
    assert.equal(task.status, "active")
    assert.equal(gate(record({ status: "planned" })).astAllowed, false)
})

test("a blocker permits read-only inspection but cannot yield conformance", () => {
    const task = record({ status: "blocked", blockers: ["diagram validation remains"] })
    assert.equal(gate(task).astAllowed, true)
    assert.equal(gate(task).readyForConformance, false)
    assert.equal(gate(task).reasons.length, 1)
    assert.equal(findRecordContradictions(task).length, 0)
    assert.equal(
        findRecordContradictions(record({ ...task, status: "completed" })).some(
            (finding) => finding.rule === "completed_with_blockers",
        ),
        true,
    )
})

test("waiting, missing or failed required evidence never becomes ready", () => {
    for (const task of [
        record({ waitingFor: [{ task: "TASK-B" }] }),
        record({ verification: [] }),
        record({ verification: [{ check: "VER-A", result: "failed", conclusion: "delivery failed" }] }),
        record({ verification: [{ check: "VER-A", result: "passed", conclusion: "" }] }),
    ]) {
        assert.equal(gate(task).readyForConformance, false)
        assert.equal(gate(task).astAllowed, false)
    }
})

test("unfinished upstream still postpones conformance and completed contradictions remain blocking", () => {
    const task = record()
    const upstream = record({ id: "TASK-B" })
    const dependentGraph = { tasks: [{ id: task.id, dependsOn: [upstream.id] }] }
    const tasks = new Map([
        [task.id, task],
        [upstream.id, upstream],
    ])
    assert.equal(evaluateTaskGate(task, dependentGraph, tasks).readyForConformance, false)
    upstream.status = "completed"
    assert.equal(evaluateTaskGate(task, dependentGraph, tasks).readyForConformance, true)
    assert.equal(
        findRecordContradictions(record({ status: "completed", verification: [] })).some(
            (finding) => finding.rule === "completed_without_required_verification",
        ),
        true,
    )
})

test("additional diagnostics do not manufacture or contradict required completion evidence", () => {
    const diagnostics = [{ check: "CHECK-DIAGNOSTIC", result: "passed", conclusion: "Source inspection only." }]
    assert.deepEqual(
        findRecordContradictions(record({ status: "completed", verification: [...record().verification, ...diagnostics] })),
        [],
    )
    assert.equal(gate(record({ verification: diagnostics })).readyForConformance, false)
})
