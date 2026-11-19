import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { checkTaskHorizontally } from "../lib/checks-b3.mjs"
import { checkDependsOnReachability } from "../lib/checks-depends.mjs"
import { parseFlowchart } from "../lib/mermaid-parse.mjs"

function diagram(id, body, kind = "structure") {
    const parsed = parseFlowchart(["flowchart LR", `%% id: ${id}`, "%% layer: L0", `%% kind: ${kind}`, ...body.split("\n")], {
        file: `${id}.md`,
        firstLine: 1,
    })
    assert.deepEqual(parsed.problems, [])
    return parsed.diagram
}

function blockers(entries, wsDiagrams = []) {
    return checkTaskHorizontally({ entries, wsDiagrams }).filter((item) => item.severity === "blocking")
}

test("a dependency cycle split across diagrams of one Task still blocks", () => {
    const entries = [
        { taskId: "TASK-A", diagram: diagram("first", "A[Alpha] -->|uses| B[Beta]") },
        { taskId: "TASK-A", diagram: diagram("second", "B[Beta] -->|uses| C[Gamma]") },
        { taskId: "TASK-A", diagram: diagram("third", "C[Gamma] -->|uses| A[Alpha]") },
    ]
    assert.ok(blockers(entries).length > 0)
    assert.deepEqual(blockers(entries.slice(0, 2)), [])
})

test("flow step order cannot create a dependency cycle against a structure view", () => {
    const entries = [
        { taskId: "TASK-A", diagram: diagram("structure", "A[Alpha] -->|uses| B[Beta]") },
        { taskId: "TASK-B", diagram: diagram("flow", "B[Beta] -->|returns to caller| A[Alpha]", "flow") },
    ]
    assert.deepEqual(blockers(entries), [])
})

test("a private intermediate node cannot hide a cycle between public boundaries", () => {
    const entries = [
        {
            taskId: "TASK-A",
            diagram: diagram("private", "%% local-only: X\nA[Alpha] -->|uses| X[Private helper]\nX -->|uses| B[Beta]"),
        },
        { taskId: "TASK-B", diagram: diagram("back", "B[Beta] -->|uses| A[Alpha]") },
    ]
    assert.ok(blockers(entries).length > 0)
})

test("private names in separate diagrams are not shared authorities", () => {
    const entries = [
        { taskId: "TASK-A", diagram: diagram("one", "%% local-only: X\nA[Alpha] -->|uses| X[Private helper]") },
        { taskId: "TASK-B", diagram: diagram("two", "%% local-only: X\nX[Private helper] -->|uses| A[Alpha]") },
    ]
    assert.deepEqual(blockers(entries), [])
})

test("a dotted result path is not a reverse structural dependency", () => {
    const entries = [
        { taskId: "TASK-A", diagram: diagram("call", "A[Alpha] -->|uses| B[Beta]") },
        { taskId: "TASK-B", diagram: diagram("result", "B[Beta] -.->|result fact| A[Alpha]") },
    ]
    assert.deepEqual(blockers(entries), [])
})

test("parent-bound identities cannot split a cycle by changing display labels", () => {
    const boundary = diagram("boundary", "A[Alpha]\nB[Beta]\nC[Gamma]")
    const entries = [
        { taskId: "TASK-A", diagram: diagram("one", "%% refines: boundary\nA[Alpha] -->|uses| B[Beta]") },
        { taskId: "TASK-B", diagram: diagram("two", "%% refines: boundary\nB[Renamed beta] -->|uses| C[Gamma]") },
        { taskId: "TASK-C", diagram: diagram("three", "%% refines: boundary\nC[Gamma] -->|uses| A[Alpha]") },
    ]
    assert.ok(blockers(entries, [boundary]).some((item) => item.rule === "cross-task-cycle"))
})

test("an explicit multi-parent refinement joins the same boundary despite different labels", () => {
    const first = diagram("first-parent", "A[Alpha boundary] -->|uses| B[Beta boundary]")
    const second = diagram("second-parent", "A[Alpha service] -->|uses| B[Beta service]")
    const child = diagram("child", "%% refines: first-parent, second-parent\nA[Alpha] -->|uses| B[Beta]")
    const entries = [{ taskId: "TASK-A", diagram: child }]
    assert.deepEqual(checkTaskHorizontally({ entries, wsDiagrams: [first, second] }), [])
    assert.deepEqual(checkTaskHorizontally({ entries, wsDiagrams: [second, first] }), [])
    second.concepts.set("A", "DifferentAuthority")
    first.concepts.set("A", "OriginalAuthority")
    const findings = checkTaskHorizontally({ entries, wsDiagrams: [first, second] })
    assert.ok(findings.some((item) => item.rule === "graph-identity-unresolved"))
})

test("declared consumption cannot omit its producing Task from the dependency DAG", () => {
    const tasks = new Map([
        ["TASK-A", { id: "TASK-A", owns: [{ path: "src/api", kind: "module" }], reads: [], diagrams: [] }],
        ["TASK-B", { id: "TASK-B", owns: [], reads: [{ path: "src/api/port.ts", kind: "module" }], diagrams: [] }],
    ])
    const planGraph = {
        error: null,
        tasks: [
            { id: "TASK-A", dependsOn: [], line: 1 },
            { id: "TASK-B", dependsOn: [], line: 2 },
        ],
    }
    const check = () => checkDependsOnReachability({ tasks, planGraph, wsDiagrams: [], planPath: "plan.md" })
    assert.ok(!check().some((item) => item.rule === "task-consumption-undeclared")) // Permission is not production.
    tasks.get("TASK-A").diagrams = [
        { problems: [], diagram: diagram("producer", "%% artifact: Api role=declaration path=src/api/port.ts\nApi[Api]") },
    ]
    assert.ok(check().some((item) => item.rule === "task-consumption-undeclared" && item.severity === "blocking"))
    planGraph.tasks[1].dependsOn = ["TASK-A"]
    assert.ok(!check().some((item) => item.rule === "task-consumption-undeclared"))
    planGraph.tasks[1].dependsOn = []
    tasks.get("TASK-B").reads[0].path = "src/api-private/port.ts"
    assert.ok(!check().some((item) => item.rule === "task-consumption-undeclared"))
})

test("protocol order cannot justify a Task dependency without a structural counterpart", () => {
    const makeTask = (id, node, file) => ({
        id,
        owns: [{ path: file, kind: "whole_file" }],
        reads: [],
        diagrams: [
            { problems: [], diagram: diagram(id, `%% artifact: ${node} role=declaration path=${file}\n${node}[${node}]`) },
        ],
    })
    const tasks = new Map([
        ["TASK-A", makeTask("TASK-A", "A", "a.ts")],
        ["TASK-B", makeTask("TASK-B", "B", "b.ts")],
    ])
    const planGraph = { error: null, tasks: [{ id: "TASK-B", dependsOn: ["TASK-A"], line: 1 }] }
    const check = (kind) =>
        checkDependsOnReachability({
            tasks,
            planGraph,
            wsDiagrams: [diagram("relation", "A[A] -->|uses| B[B]", kind)],
            planPath: "plan.md",
        })
    assert.ok(check("flow").some((item) => item.rule === "depends-on-not-explained-by-diagram"))
    assert.ok(!check("structure").some((item) => item.rule === "depends-on-not-explained-by-diagram"))
})

test("CLI rejects a Workstream cycle split across individually acyclic structure views", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-decoupling-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const views = [
        ["first", "A[Alpha] -->|uses| B[Beta]"],
        ["second", "B[Beta] -->|uses| C[Gamma]"],
        ["third", "C[Gamma] -->|uses| A[Alpha]"],
    ]
    const spec = (items) =>
        "# Architecture\n\nArchitecture-Mode: diagram-driven-v1\n\nArrow labels are normative: `uses`.\n" +
        items
            .map(
                ([id, body]) =>
                    `\n\`\`\`mermaid\nflowchart LR\n%% id: ${id}\n%% layer: L0\n%% kind: structure\n%% answers: dependency boundary\n${body}\n\`\`\`\n`,
            )
            .join("")
    const cli = fileURLToPath(new URL("../verify-diagrams.mjs", import.meta.url))
    const run = (items) => {
        fs.writeFileSync(path.join(root, "spec.md"), spec(items))
        const result = spawnSync(
            process.execPath,
            [cli, "--workstream", root, "--scope", "workstream", "--json", "--no-self-test"],
            {
                cwd: root,
                encoding: "utf8",
            },
        )
        assert.equal(result.error, undefined)
        return { result, report: JSON.parse(result.stdout) }
    }
    const cyclic = run(views)
    assert.equal(cyclic.result.status, 1, cyclic.result.stderr || cyclic.result.stdout)
    assert.equal(cyclic.report.exitCode, 1)
    assert.ok(cyclic.report.findings.some((item) => item.severity === "blocking" && item.rule.includes("cycle")))
    const acyclic = run(views.slice(0, 2))
    assert.equal(acyclic.result.status, 0, acyclic.result.stderr || acyclic.result.stdout)
})
