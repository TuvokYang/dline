import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { checkCodeConformance, findAuthorityConflicts, proveEvidenceEdge } from "../lib/checks-code-conformance.mjs"
import { parseFlowchart } from "../lib/mermaid-parse.mjs"
import { checkPortRefinement } from "../lib/port-refinement.mjs"
import { buildDependencyClosure } from "../lib/tree-sitter-dependencies.mjs"

function diagram(id, body, layer = "L0") {
    const parsed = parseFlowchart(
        ["flowchart LR", `%% id: ${id}`, `%% layer: ${layer}`, "%% kind: structure", "%% answers: boundary contract", ...body],
        { file: `${id}.md`, firstLine: 1 },
    )
    assert.deepEqual(parsed.problems, [])
    return parsed
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-boundary-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

const parent = () =>
    diagram("parent", [
        "%% ports: A completeness=complete",
        "%% port: A.receive mode=in type=Request.v1 required=true",
        "A[Boundary]",
    ]).diagram

test("a partial port view can omit a parent obligation without claiming complete coverage", () => {
    const fine = diagram("child", ["%% refines: parent", "%% ports: A completeness=partial", "A[Boundary]"], "L1").diagram
    assert.deepEqual(checkPortRefinement(parent(), fine), [])
    fine.portContracts.inventories.get("A").completeness = "complete"
    assert.ok(checkPortRefinement(parent(), fine).some((item) => item.rule === "port-required-omitted"))
})

test("refinement preserves direction, nominal type and required obligations", () => {
    for (const signature of [
        "mode=out type=Request.v1 required=true",
        "mode=in type=Request.v2 required=true",
        "mode=in type=Request.v1 required=false",
    ]) {
        const fine = diagram(
            "child",
            ["%% refines: parent", "%% ports: A completeness=partial", `%% port: A.receive ${signature}`, "A[Boundary]"],
            "L1",
        ).diagram
        assert.ok(
            checkPortRefinement(parent(), fine).some((item) => item.rule === "port-contract-changed"),
            signature,
        )
    }
    const fine = diagram(
        "child",
        [
            "%% refines: parent",
            "%% ports: A completeness=partial",
            "%% port: A.extra mode=in type=Other required=false",
            "A[Boundary]",
        ],
        "L1",
    ).diagram
    assert.ok(checkPortRefinement(parent(), fine).some((item) => item.rule === "port-undeclared-upstream"))
    const coarse = parent()
    coarse.portContracts.inventories.get("A").completeness = "partial"
    assert.deepEqual(checkPortRefinement(coarse, fine), [])
})

test("the CLI runs port checks in workstream, Task and aggregate scopes", (t) => {
    const root = fixture(t)
    const taskDir = path.join(root, "tasks", "TASK-001-boundary")
    fs.mkdirSync(taskDir, { recursive: true })
    const view = (id, type, fine = false) =>
        `\n\`\`\`mermaid\nflowchart LR\n%% id: ${id}\n%% layer: ${fine ? "L1" : "L0"}\n%% kind: structure\n%% answers: dependency contract\n${fine ? "%% refines: parent\n" : ""}%% ports: A completeness=complete\n%% ports: B completeness=complete\n%% port: A.use mode=requires type=Port.v1 required=true\n%% port: B.api mode=provides type=${type} required=true\n%% edge-ports: from=A to=B style=solid label="uses" from_port=use to_port=api\nA[A] -->|uses| B[B]\n\`\`\`\n`
    fs.writeFileSync(
        path.join(root, "spec.md"),
        "# Architecture\n\nArchitecture-Mode: diagram-driven-v1\n\nArrow labels are normative: `uses`.\n" +
            view("parent", "Port.v1"),
    )
    fs.writeFileSync(
        path.join(taskDir, "goals.yaml"),
        "id: TASK-001\nobjective: Boundary\nowns: []\nreads: []\nrequired_verification: {}\n",
    )
    fs.writeFileSync(path.join(taskDir, "progress.md"), "---\nstatus: planned\nverification: []\n---\n")
    fs.writeFileSync(path.join(taskDir, "plan.md"), "# Task\n" + view("child", "WrongPort", true))
    const cli = fileURLToPath(new URL("../verify-diagrams.mjs", import.meta.url))
    const run = (scope) => {
        const result = spawnSync(process.execPath, [cli, "--workstream", root, "--scope", scope, "--json", "--no-self-test"], {
            cwd: root,
            encoding: "utf8",
        })
        assert.equal(result.error, undefined)
        return { status: result.status, report: JSON.parse(result.stdout) }
    }
    assert.equal(run("workstream").status, 0)
    for (const scope of ["task:TASK-001", "all"]) {
        const result = run(scope)
        assert.equal(result.status, 1)
        assert.ok(result.report.findings.some((item) => item.rule === "port-type-mismatch"))
        assert.ok(result.report.findings.some((item) => item.rule === "port-contract-changed"))
    }
    fs.writeFileSync(path.join(taskDir, "plan.md"), "# Task\n" + view("child", "Port.v1", true))
    assert.equal(run("all").status, 0)
})

test("renaming the same parent-bound fact cannot hide conflicting writers", async (t) => {
    const root = fixture(t)
    for (const file of ["a.ts", "b.ts"]) fs.writeFileSync(path.join(root, file), "export function write() {}")
    const task = (id, file, label) => ({
        id,
        status: "completed",
        planPath: `${id}/plan.md`,
        goalsPath: `${id}/goals.yaml`,
        diagrams: [
            diagram(
                id,
                ["%% refines: parent", `%% artifact: Fact role=writer path=${file} symbol=write`, `Fact[${label}]`],
                "L1",
            ),
        ],
        owns: [{ path: file, kind: "whole_file" }],
        reads: [],
        requiredVerification: new Map(),
    })
    const a = task("TASK-A", "a.ts", "Stored state")
    const b = task("TASK-B", "b.ts", "Different display label")
    const check = () =>
        checkCodeConformance({
            repoRoot: root,
            spec: { diagrams: [diagram("parent", ["Fact[Canonical state]"])] },
            tasks: new Map([
                [a.id, a],
                [b.id, b],
            ]),
        })
    assert.ok((await check()).some((item) => item.rule === "authority-writer-conflict" && item.severity === "blocking"))
    b.diagrams[0].diagram.artifacts.get("Fact")[0].path = "a.ts"
    assert.ok(!(await check()).some((item) => item.rule === "authority-writer-conflict"))
})

test("writer declaration names retain case rather than inheriting path normalization", () => {
    const claim = (writer) => ({ fact: "State", writer, taskId: "TASK-A", status: "completed" })
    assert.equal(findAuthorityConflicts([claim("store.ts#Write"), claim("store.ts#write")]).length, 1)
    assert.equal(findAuthorityConflicts([claim("store.ts#Writer.save"), claim("store.ts#Other.save")]).length, 1)
    assert.equal(findAuthorityConflicts([claim("./store.ts#Writer.save"), claim("store.ts#Writer.save")]).length, 0)
})

test("direct-import evidence cannot borrow a differently named target declaration", async (t) => {
    const root = fixture(t)
    fs.writeFileSync(path.join(root, "a.ts"), 'import { publicPort } from "./b"; export function run() { publicPort() }')
    fs.writeFileSync(path.join(root, "b.ts"), "export function publicPort() {}\nexport function secret() {}")
    const closure = await buildDependencyClosure({ repoRoot: root, seeds: ["a.ts"] })
    const snapshot = {
        ...closure,
        imports: closure.imports.map((edge) => ({ ...edge, typeOnly: edge.classification === "type" })),
    }
    const prove = (symbol) =>
        proveEvidenceEdge({
            edge: { kind: "direct_import", emit: { path: "a.ts", symbol: "run" }, receive: { path: "b.ts", symbol } },
            codeSnapshot: snapshot,
            presentArtifacts: new Set(["a.ts", "b.ts"]),
        })
    assert.equal(prove("publicPort").status, "proven")
    assert.equal(prove("secret").status, "unverifiable")
})
