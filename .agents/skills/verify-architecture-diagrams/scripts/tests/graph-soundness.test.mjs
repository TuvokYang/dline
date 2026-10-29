import assert from "node:assert/strict"
import test from "node:test"

import { checkTaskAgainstWorkstream } from "../lib/checks-b2.mjs"
import { checkInterLevel, checkLayerSequence } from "../lib/checks-interlevel.mjs"
import { checkCycles, checkIntraLayer } from "../lib/checks-intra.mjs"
import { checkTaskGraph } from "../lib/checks-task-graph.mjs"
import { parseFlowchart } from "../lib/mermaid-parse.mjs"

function diagram(source, file = "spec.md") {
    const parsed = parseFlowchart(source.trim().split(/\r?\n/), { file, firstLine: 1 })
    assert.deepEqual(parsed.problems, [])
    return parsed.diagram
}

function rules(findings) {
    return findings.map((finding) => finding.rule)
}

test("one cycle exemption matches only its declared SCC", () => {
    const model = diagram(`
flowchart LR
%% kind: structure
%% cycle: allowed nodes=A|B owner=TASK-X reason=required
A[A] -->|hands| B[B]
B -->|hands| A
C[C] -->|hands| D[D]
D -->|hands| C
`)
    const result = rules(checkCycles(model))
    assert.equal(result.filter((rule) => rule === "cycle-exempted").length, 1)
    assert.equal(result.filter((rule) => rule === "solid-cycle").length, 1)
})

test("note nodes cannot participate in dependency edges", () => {
    const model = diagram(`
flowchart LR
%% note-node: B
A[A] -->|hands| B[B]
B -->|hands| A
`)
    assert.ok(rules(checkIntraLayer(model, new Set(["hands"]))).includes("note-node-has-edge"))
})

test("fine diagram must preserve every coarse edge as a nonzero same-style path", () => {
    const coarse = diagram(`
flowchart LR
%% id: coarse
%% layer: L0
A[A] -->|hands| B[B]
`)
    const removed = diagram(`
flowchart LR
%% id: removed
%% layer: L1
%% refines: coarse
A[A]
B[B]
`)
    assert.ok(rules(checkInterLevel(coarse, removed, { declared: true })).includes("coarse-edge-not-refined"))

    const refined = diagram(`
flowchart LR
%% id: refined
%% layer: L1
%% refines: coarse
%% local-only: Detail
A[A] -->|hands| Detail[Detail]
Detail -->|hands| B[B]
`)
    assert.ok(!rules(checkInterLevel(coarse, refined, { declared: true })).includes("coarse-edge-not-refined"))
})

test("layer sequence and Task Graph are checked as DAG contracts", () => {
    const l0 = diagram("flowchart LR\n%% id: l0\n%% layer: L0\nA[A]", "spec.md")
    const l2 = diagram("flowchart LR\n%% id: l2\n%% layer: L2\nA[A]", "spec.md")
    assert.ok(rules(checkLayerSequence([l0, l2])).includes("layer-skipped"))
    assert.deepEqual(checkLayerSequence([l0, l2], { scope: "task" }), [])

    const plan = {
        error: null,
        tasks: [
            { id: "TASK-A", dependsOn: ["TASK-B"], executionMode: "serial", line: 2 },
            { id: "TASK-B", dependsOn: ["TASK-A"], executionMode: "parallel_when_ready", line: 3 },
            { id: "TASK-C", dependsOn: ["TASK-Z"], executionMode: "invalid", line: 4 },
        ],
    }
    const result = rules(checkTaskGraph(plan, "plan.md"))
    assert.ok(result.includes("task-dependency-cycle"))
    assert.ok(result.includes("task-dependency-unknown"))
    assert.ok(result.includes("task-execution-mode-invalid"))
})

test("task diagrams validate every declared Workstream parent", () => {
    const first = diagram("flowchart LR\n%% id: first\nA[A] -->|hands| B[B]", "spec.md")
    const second = diagram("flowchart LR\n%% id: second\nC[C] -->|hands| D[D]", "spec.md")
    const task = diagram(
        `
flowchart LR
%% refines: first, second
A[A] -->|hands| B[B]
C[C] -->|hands| D[D]
`,
        "task.md",
    )
    const findings = checkTaskAgainstWorkstream({
        taskId: "TASK-X",
        taskDiagram: task,
        wsDiagrams: [first, second],
        labelVocabulary: new Set(["hands"]),
        specText: "",
    })
    assert.deepEqual(
        findings.filter((finding) => finding.severity === "blocking"),
        [],
    )
})
