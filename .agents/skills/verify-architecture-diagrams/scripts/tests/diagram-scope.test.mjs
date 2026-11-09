import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { checkCodeConformance, proveEvidenceEdge } from "../lib/checks-code-conformance.mjs"
import { parseArchitectureEvidence } from "../lib/evidence-model.mjs"
import { parseFlowchart } from "../lib/mermaid-parse.mjs"
import { buildDependencyClosure } from "../lib/tree-sitter-dependencies.mjs"

function fixture(t, files) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dline-diagram-scope-"))
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
    for (const [file, source] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true })
        fs.writeFileSync(path.join(repoRoot, file), source)
    }
    return repoRoot
}

function task(id, symbol = "changed") {
    const parsed = parseFlowchart(
        [
            "flowchart LR",
            `%% id: ${id}`,
            `%% artifact: Source role=declaration path=subject.ts${symbol ? ` symbol=${symbol}` : ""} expect=present`,
            "Source[Source]",
        ],
        { file: `${id}/plan.md`, firstLine: 1 },
    )
    assert.deepEqual(parsed.problems, [])
    return {
        id,
        status: "active",
        planPath: `${id}/plan.md`,
        goalsPath: `${id}/goals.yaml`,
        progressPath: `${id}/progress.md`,
        diagrams: [parsed],
        owns: [{ path: "subject.ts", kind: "section", selector: "本任务的职责范围" }],
        reads: [{ path: "good.ts", kind: "module" }],
        changedFiles: [],
        changedRegions: [],
        evidenceProblems: [],
        requiredVerification: new Map(),
    }
}
const run = (repoRoot, tasks) =>
    checkCodeConformance({ repoRoot, spec: { diagrams: [] }, tasks: new Map(tasks.map((entry) => [entry.id, entry])) })
const dependencies = (findings) =>
    findings.filter((entry) => ["actual-edge-undeclared", "actual-edge-outbound-boundary"].includes(entry.rule))
const sources = {
    "subject.ts":
        'import { good } from "./good"; import { legacy } from "./legacy"; export function changed() { return good() } export function untouched() { return legacy() }',
    "good.ts": "export function good() { return 1 }",
    "legacy.ts": "export function legacy() { return 2 }",
}

test("diagram function bindings define inspection scope without requiring a changed-region registry", async (t) => {
    const source = task("TASK-A")
    source.owns.push({ path: "unrelated.ts", kind: "module" })
    source.changedFiles = ["unrelated.ts"]
    source.changedRegions = [{ path: "unrelated.ts", boundary: { kind: "section", selector: "修改说明，不是源码选择器" } }]
    const findings = await run(fixture(t, { ...sources, "unrelated.ts": "export function broken(" }), [source])
    assert.deepEqual(dependencies(findings), [])
    assert.equal(
        findings.some((entry) => entry.rule === "code-fact-diagnostic" || entry.rule.startsWith("changed-")),
        false,
    )
})

test("a boundary-crossing dependency inside the diagram function remains a finding", async (t) => {
    const findings = await run(
        fixture(t, { ...sources, "subject.ts": sources["subject.ts"].replace("return good()", "return legacy()") }),
        [task("TASK-A")],
    )
    assert.equal(dependencies(findings).length, 1)
    assert.equal(dependencies(findings)[0].task, "TASK-A")
})

test("missing or incorrectly qualified diagram functions never become valid definitions", async (t) => {
    const root = fixture(t, sources)
    for (const symbol of ["Changed", "Missing.run"]) {
        const findings = await run(root, [task("TASK-A", symbol)])
        assert.ok(
            findings.some(
                (entry) => entry.rule === "artifact-symbol-unverifiable" || entry.rule === "diagram-symbol-unverifiable",
            ),
        )
    }
})

test("read interfaces support graph checks without auditing their unrelated implementation dependencies", async (t) => {
    const root = fixture(t, {
        ...sources,
        "good.ts": 'import { legacy } from "./legacy"; export function good() { return legacy() }',
    })
    assert.deepEqual(dependencies(await run(root, [task("TASK-A")])), [])
})

test("shared-file graph functions preserve their emitting Task's dependency boundary", async (t) => {
    const root = fixture(t, { ...sources, "subject.ts": sources["subject.ts"].replace("return legacy()", "return good()") })
    const a = task("TASK-A")
    const b = task("TASK-B", "untouched")
    b.reads = []
    const found = dependencies(await run(root, [a, b]))
    assert.equal(found.length, 1)
    assert.equal(found[0].task, "TASK-B")
})

test("unresolved references inside a graph-bound function remain unproven", async (t) => {
    const root = fixture(t, {
        ...sources,
        "subject.ts": 'import { missing } from "./absent"; export function changed() { return missing() }',
    })
    const findings = await run(root, [task("TASK-A")])
    assert.ok(findings.some((entry) => entry.rule === "actual-edge-unresolved" && entry.severity === "unverifiable"))
})

test("declared directory interfaces do not authorize similarly named neighbouring boundaries", async (t) => {
    const root = fixture(t, {
        "subject.ts":
            'import { good } from "./contracts/good"; import { legacy } from "./contracts-old/legacy"; export function changed() { return good() } export function untouched() { return legacy() }',
        "contracts/good.ts": "export function good() { return 1 }",
        "contracts-old/legacy.ts": "export function legacy() { return 2 }",
    })
    const source = task("TASK-A")
    source.reads = [{ path: "contracts", kind: "module" }]
    assert.deepEqual(dependencies(await run(root, [source])), [])
    const wholeModule = task("TASK-A", null)
    wholeModule.reads = source.reads
    const found = dependencies(await run(root, [wholeModule]))
    assert.equal(found.length, 1)
    assert.equal(found[0].task, "TASK-A")
})

test("local parameter shadowing does not forge a dependency, while module initialization stays visible", async (t) => {
    const root = fixture(t, {
        ...sources,
        "subject.ts":
            'import { legacy } from "./legacy"; import "./other"; export function changed(legacy: () => void) { return legacy() }',
        "other.ts": "export const initialized = true",
    })
    const found = dependencies(await run(root, [task("TASK-A")]))
    assert.equal(found.length, 1)
    assert.equal(found[0].file, "subject.ts")
})

function evidenceTask(artifacts) {
    const source = task("TASK-A", null)
    source.diagrams[0].diagram.artifacts.clear()
    const entries = artifacts
        .map(
            (artifact) =>
                `        - {${Object.entries(artifact)
                    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                    .join(", ")}}`,
        )
        .join("\n")
    const { evidence, problems } = parseArchitectureEvidence(
        `## Architecture Evidence\n\n\`\`\`yaml\narchitecture_evidence:\n  schema_version: 2\n  diagram_id: TASK-A\n  nodes:\n    Source:\n      artifacts:\n${entries}\n  edges: []\n\`\`\``,
        source.planPath,
    )
    source.architectureEvidence = evidence
    source.evidenceProblems = problems
    return source
}

test("explicit support bindings validate definitions without promoting their unrelated implementation into scope", async (t) => {
    const source = evidenceTask([
        { id: "subject", path: "subject.ts", role: "declaration", symbol: "changed" },
        { id: "support", path: "good.ts", role: "receiver", symbol: "good", inspection: "support" },
    ])
    assert.deepEqual(source.evidenceProblems, [])
    const root = fixture(t, {
        ...sources,
        "good.ts": 'import { legacy } from "./legacy"; export function good() { return legacy() }',
    })
    assert.deepEqual(dependencies(await run(root, [source])), [])
    source.architectureEvidence.nodes.get("Source").artifacts[1].symbol = "missing"
    assert.ok((await run(root, [source])).some((entry) => entry.rule === "diagram-symbol-unverifiable"))
})

test("module bindings inspect production sources and detect a dependency absent from the graph", async (t) => {
    const source = evidenceTask([{ id: "module", path: "module", role: "declaration" }])
    source.owns = [{ path: "module", kind: "module" }]
    source.reads = []
    const root = fixture(t, {
        "module/service.ts": 'import { legacy } from "../legacy"; export function run() { return legacy() }',
        "module/__tests__/service.test.ts": 'import { unrelated } from "../../unrelated"; unrelated()',
        "legacy.ts": sources["legacy.ts"],
        "unrelated.ts": "export function unrelated() {}",
    })
    const found = dependencies(await run(root, [source]))
    assert.equal(found.length, 1)
    assert.equal(found[0].file, "module/service.ts")
})

test("one Task's drawn import edge does not authorize another Task's shared-file function", async (t) => {
    const a = task("TASK-A")
    a.reads = []
    a.diagrams = [
        parseFlowchart(
            [
                "flowchart LR",
                "%% id: TASK-A",
                "%% artifact: Source role=declaration path=subject.ts symbol=changed expect=present",
                "%% artifact: Target role=receiver path=good.ts expect=present",
                "Source[Source] -->|calls| Target[Target]",
            ],
            { file: a.planPath, firstLine: 1 },
        ),
    ]
    const b = task("TASK-B", "untouched")
    b.reads = []
    const root = fixture(t, { ...sources, "subject.ts": sources["subject.ts"].replace("return legacy()", "return good()") })
    const found = dependencies(await run(root, [a, b]))
    assert.equal(found.length, 1)
    assert.equal(found[0].task, "TASK-B")
})

test("a direct-import witness bound to a function cannot borrow a sibling function's dependency", async (t) => {
    const root = fixture(t, { ...sources, "subject.ts": sources["subject.ts"].replace("return good()", "return legacy()") })
    const closure = await buildDependencyClosure({ repoRoot: root, seeds: ["subject.ts"] })
    const snapshot = {
        ...closure,
        imports: closure.imports.map((entry) => ({ ...entry, typeOnly: entry.classification === "type" })),
    }
    const prove = (symbol) =>
        proveEvidenceEdge({
            edge: { kind: "direct_import", emit: { path: "subject.ts", symbol }, receive: { path: "good.ts", symbol: "good" } },
            codeSnapshot: snapshot,
            presentArtifacts: new Set(["subject.ts", "good.ts"]),
        })
    assert.equal(prove("changed").status, "contradicted")
    assert.equal(prove(null).status, "proven") // A module-level structural import is still a different, valid claim.
    assert.equal(prove("missing").status, "unverifiable")
})

test("unknown inspection modes cannot silently remove a module from verification", () => {
    const source = evidenceTask([{ id: "module", path: "module", role: "declaration", inspection: "skip" }])
    assert.ok(source.evidenceProblems.some((entry) => entry.rule === "artifact-inspection-unknown"))
})
