// Reference-boundary conformance: what a declaration may authorize, at which identity,
// and for which emitting Task. A contract must never degrade into a file-level permission.

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { checkCodeConformance } from "../lib/checks-code-conformance.mjs"
import { parseFlowchart } from "../lib/mermaid-parse.mjs"
import { containsPath, counterpartAllows, declaredCounterparts, sameSignal, signalState } from "../lib/reference-contracts.mjs"
import { buildDependencyClosure } from "../lib/tree-sitter-dependencies.mjs"

function fixture(t, files) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dline-reference-boundary-"))
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
    for (const [file, source] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true })
        fs.writeFileSync(path.join(repoRoot, file), source)
    }
    return repoRoot
}

function taskDiagram(id, lines, file = `${id}/plan.md`) {
    const parsed = parseFlowchart(["flowchart LR", `%% id: ${id}`, ...lines], { file, firstLine: 1 })
    assert.deepEqual(parsed.problems, [])
    return parsed
}

function taskRecord({ id = "TASK-A", status = "active", lines = [], owns = [], reads = [], evidence = null } = {}) {
    return {
        id,
        status,
        planPath: `${id}/plan.md`,
        goalsPath: `${id}/goals.yaml`,
        progressPath: `${id}/progress.md`,
        diagrams: lines.length > 0 ? [taskDiagram(id, lines)] : [],
        owns,
        reads: reads.map((read) => (typeof read === "string" ? { path: read, kind: "module", selector: null } : read)),
        architectureEvidence: evidence,
        evidenceProblems: [],
        requiredVerification: new Map(),
        verification: [],
    }
}

const run = (repoRoot, tasks) =>
    checkCodeConformance({ repoRoot, spec: { diagrams: [] }, tasks: new Map(tasks.map((entry) => [entry.id, entry])) })

const undeclared = (findings) =>
    findings.filter((entry) => ["actual-edge-undeclared", "actual-edge-outbound-boundary"].includes(entry.rule))

const referenceProblems = (findings) =>
    findings.filter(
        (entry) =>
            entry.rule.startsWith("actual-edge-") ||
            ["artifact-symbol-unverifiable", "diagram-symbol-unverifiable"].includes(entry.rule),
    )

const source = {
    "b.ts": "export function b() { return 1 }\n",
    "a.ts": 'import { b } from "./b"\nexport function a() { return b() }\n',
}

function evidenceFor(emitFile, emitSymbol, receivePath) {
    return {
        schemaVersion: 2,
        diagramId: "TASK-A",
        file: "TASK-A/plan.md",
        nodes: new Map(),
        artifactById: new Map(),
        edges: [
            {
                id: "TASK-A/emit/receive",
                from: "Source",
                to: "Target",
                style: "solid",
                label: "hands",
                kind: "direct_import",
                emit: { path: emitFile, symbol: emitSymbol },
                receive: { path: receivePath, symbol: null },
                contract: null,
                assembly: null,
                rpc: null,
                proof: [],
            },
        ],
    }
}

test("a flow step is protocol order and grants no import permission", async (t) => {
    const lines = (kind) => [
        `%% kind: ${kind}`,
        "%% artifact: A role=declaration path=a.ts",
        "%% artifact: B role=receiver path=b.ts",
        "A[A] -->|hands over| B[B]",
    ]
    const owns = [{ path: "a.ts", kind: "module" }]
    const flow = await run(fixture(t, source), [taskRecord({ lines: lines("flow"), owns })])
    assert.equal(undeclared(flow).length, 1)
    assert.equal(undeclared(flow)[0].file, "a.ts")

    const structure = await run(fixture(t, source), [taskRecord({ lines: lines("structure"), owns })])
    assert.deepEqual(undeclared(structure), [])
})

test("a dotted flow reason is a fact, not a structural counterpart", async (t) => {
    const findings = await run(fixture(t, source), [
        taskRecord({
            lines: [
                "%% kind: structure",
                "%% artifact: A role=declaration path=a.ts",
                "%% artifact: B role=receiver path=b.ts",
                "A[A] -.->|result fact| B[B]",
            ],
            owns: [{ path: "a.ts", kind: "module" }],
        }),
    ])
    assert.equal(undeclared(findings).length, 1)
})

test("two emitting functions in one file never share one reference permission", async (t) => {
    const root = fixture(t, {
        "entry.ts":
            'import { helper } from "./helper"\n' +
            "export function changed() { return 1 }\n" +
            "export function untouched() { return helper() }\n",
        "helper.ts": "export function helper() { return 1 }\n",
    })
    const closure = await buildDependencyClosure({ repoRoot: root, seeds: ["entry.ts"] })
    const codeSnapshot = {
        ...closure,
        imports: closure.imports.map((edge) => ({ ...edge, typeOnly: edge.classification === "type" })),
    }
    const helperEdge = codeSnapshot.imports.find((edge) => String(edge.target.path).endsWith("helper.ts"))
    const reference = { edge: helperEdge, importer: "entry.ts", target: "helper.ts" }
    const permission = (emitSymbol) =>
        counterpartAllows(
            declaredCounterparts(taskRecord({ evidence: evidenceFor("entry.ts", emitSymbol, "helper.ts") }))[0],
            reference,
            {
                codeSnapshot,
            },
        )
    const changed = permission("changed")
    const missing = permission("missing")
    // The import exists in the file and names `helper`; declaring the other function's
    // boundary, or one that resolves to nothing, leaves the reference explicitly unproven
    // instead of granting it the whole file.
    assert.notEqual(changed.state, "allowed")
    assert.equal(missing.state, "unverifiable")
    assert.match(missing.reason, /cannot be resolved/)
    assert.match(changed.reason, /no modelled use|changed/)
})

test("alias and barrel permissions follow exact declaration identity, not exported spelling", async (t) => {
    const root = fixture(t, {
        "service.ts": "export function save() {}\nexport function load() {}",
        "barrel.ts": 'export { save as publicSave } from "./service"',
        "consumer.ts": 'import { publicSave as persist } from "./barrel"; export function run() { persist() }',
    })
    const snapshot = await buildDependencyClosure({ repoRoot: root, seeds: ["consumer.ts"] })
    const edge = snapshot.imports.find((entry) => entry.importer === "consumer.ts")
    const declaration = { from: "consumer.ts", path: "service.ts", kind: "symbol", selector: "save" }
    const permission = (overrides = {}) =>
        counterpartAllows({ ...declaration, ...overrides }, { edge }, { codeSnapshot: snapshot })
    assert.equal(permission().state, "allowed")
    assert.notEqual(permission({ selector: "load" }).state, "allowed")
    assert.notEqual(permission({ selector: "persist" }).state, "allowed")
    assert.notEqual(permission({ path: "barrel.ts", selector: "publicSave" }).state, "allowed")
    assert.equal(signalState(edge, "save", { path: "service.ts" }).declarations[0].symbol, "save")
    assert.equal(signalState({ ...edge, bindings: [] }, "save").state, "unverifiable")
})

test("a qualified member matches its own name and a path boundary matches its own segment", () => {
    assert.equal(sameSignal("Service.save", "save"), false)
    assert.equal(sameSignal("Service.save", "Other.save"), false)
    assert.equal(sameSignal("Service.save", "Service.save"), true)
    assert.equal(sameSignal("Service.save", "load"), false)
    assert.equal(sameSignal("orderSave", "save"), false)
    assert.equal(containsPath("contracts", "contracts-old/port.ts"), false)
    assert.equal(containsPath("contracts", "contracts/port.ts"), true)
})

test("read references never authorize an import absent from the structure contract", async (t) => {
    const lines = [
        "%% kind: structure",
        "%% artifact: A role=declaration path=src/a.ts",
        "%% artifact: B role=receiver path=src/b.ts",
        "A[A] -->|hands over| B[B]",
    ]
    const owns = [{ path: "src/a.ts", kind: "module" }]
    const root = fixture(t, {
        "src/b.ts": "export function b() { return 1 }\n",
        "src/secret.ts": "export function secret() { return 2 }\n",
        "src/a.ts": 'import { b } from "./b"\nimport { secret } from "./secret"\nexport function a() { return b() + secret() }\n',
    })
    for (const read of [
        "src/secret.ts",
        { path: "src", kind: "module" },
        { path: "src/secret.ts", kind: "whole_file" },
        { path: "src/secret.ts", kind: "symbol", selector: "secret" },
        { path: "src/secret.ts", kind: "section", selector: "Semantic reference only" },
    ]) {
        const findings = await run(root, [taskRecord({ lines, owns, reads: [read] })])
        const found = undeclared(findings)
        assert.equal(found.length, 1, JSON.stringify(read))
        assert.equal(found[0].rule, "actual-edge-outbound-boundary")
        assert.equal(found[0].severity, "blocking")
        assert.equal(found[0].file, "src/a.ts")
        assert.match(found[0].message, /secret\.ts/)
        assert.equal(
            findings.some((entry) => entry.rule === "actual-edge-unverifiable"),
            false,
        )
    }

    const declared = [
        ...lines,
        "%% artifact: Secret role=receiver path=src/secret.ts symbol=secret",
        "A -->|uses| Secret[Secret]",
    ]
    assert.deepEqual(referenceProblems(await run(root, [taskRecord({ lines: declared, owns })])), [])
})

test("a type-only import also needs an explicit counterpart rather than a read reference", async (t) => {
    const root = fixture(t, {
        "contract.ts": "export interface Input { value: string }",
        "consumer.ts": 'import type { Input } from "./contract"; export function use(input: Input) { return input.value }',
    })
    const lines = ["%% kind: structure", "%% artifact: Consumer role=declaration path=consumer.ts", "Consumer[Consumer]"]
    const record = taskRecord({ lines, reads: [{ path: "contract.ts", kind: "symbol", selector: "Input" }] })
    const found = undeclared(await run(root, [record]))
    assert.equal(found.length, 1)
    assert.equal(found[0].severity, "blocking")
    assert.match(found[0].message, /type-only/)
    const declared = [
        ...lines,
        "%% artifact: Port role=declaration path=contract.ts symbol=Input",
        "Consumer -->|uses type| Port[Port]",
    ]
    assert.deepEqual(referenceProblems(await run(root, [taskRecord({ lines: declared })])), [])
})

test("a read reference without an import introduces no undeclared dependency", async (t) => {
    const root = fixture(t, { "a.ts": "export function a() { return 1 }", "b.ts": source["b.ts"] })
    const findings = await run(root, [
        taskRecord({
            lines: ["%% artifact: A role=declaration path=a.ts", "A[A]"],
            reads: [{ path: "b.ts", kind: "module" }],
        }),
    ])
    assert.deepEqual(referenceProblems(findings), [])
})

test("a drawn edge that names another identity stays unverifiable, not undeclared", async (t) => {
    const findings = await run(fixture(t, source), [
        taskRecord({
            lines: [
                "%% kind: structure",
                "%% artifact: A role=declaration path=a.ts",
                "%% artifact: B role=receiver path=b.ts symbol=other",
                "A[A] -->|hands over| B[B]",
            ],
            owns: [{ path: "a.ts", kind: "module" }],
            reads: [{ path: "b.ts", kind: "module" }],
        }),
    ])
    assert.deepEqual(undeclared(findings), [])
    const open = findings.filter((entry) => entry.rule === "actual-edge-unverifiable")
    assert.equal(open.length, 1)
    assert.equal(open[0].severity, "unverifiable")
})

test("explicit symbol counterparts require every binding and the exact emitting region", async (t) => {
    const root = fixture(t, {
        "shared.ts": "export function save() {}\nexport function secret() {}",
        "consumer.ts":
            'import { save as persist, secret } from "./shared"; export function first() { persist() } export function second() { secret() }',
    })
    const snapshot = await buildDependencyClosure({ repoRoot: root, seeds: ["consumer.ts"] })
    const edge = snapshot.imports.find((entry) => entry.importer === "consumer.ts")
    const options = { codeSnapshot: snapshot }
    const declaration = {
        from: "consumer.ts",
        fromKind: "symbol",
        regionSymbol: "first",
        path: "shared.ts",
        kind: "symbol",
        selector: "save",
    }
    const first = { ...edge, bindings: [edge.bindings.find((binding) => binding.imported === "save")] }
    const second = { ...edge, bindings: [edge.bindings.find((binding) => binding.imported === "secret")] }
    assert.notEqual(counterpartAllows(declaration, { edge }, options).state, "allowed")
    assert.equal(counterpartAllows(declaration, { edge: first }, options).state, "allowed")
    assert.notEqual(counterpartAllows(declaration, { edge: second }, options).state, "allowed")
    assert.notEqual(counterpartAllows({ ...declaration, selector: "secret" }, { edge: second }, options).state, "allowed")
    assert.equal(
        counterpartAllows({ ...declaration, regionSymbol: "second", selector: "secret" }, { edge: second }, options).state,
        "allowed",
    )
    assert.notEqual(counterpartAllows({ ...declaration, from: "elsewhere.ts" }, { edge: first }, options).state, "allowed")
})

test("only an implemented Task blocks on an undeclared in-boundary reference", async (t) => {
    const lines = ["%% kind: structure", "%% artifact: A role=declaration path=a.ts", "%% artifact: B role=receiver path=b.ts"]
    const owns = [{ path: "a.ts", kind: "module" }]
    const severities = new Map([
        ["planned", "warning"],
        ["active", "blocking"],
        ["blocked", "blocking"],
        ["completed", "blocking"],
    ])
    for (const [status, expected] of severities) {
        const findings = undeclared(await run(fixture(t, source), [taskRecord({ status, lines, owns })]))
        assert.equal(findings.length, 1, status)
        assert.equal(findings[0].rule, "actual-edge-undeclared", status)
        assert.equal(findings[0].severity, expected, status)
    }
})

test("a reference to an unmapped workspace target is still an undeclared dependency", async (t) => {
    const findings = undeclared(
        await run(fixture(t, source), [
            taskRecord({
                status: "completed",
                lines: ["%% artifact: A role=declaration path=a.ts"],
                owns: [{ path: "a.ts", kind: "module" }],
            }),
        ]),
    )
    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule, "actual-edge-outbound-boundary")
    assert.equal(findings[0].severity, "blocking")
})

test("a same-line sibling binding cannot borrow another emitting function's edge", async (t) => {
    const root = fixture(t, {
        "shared.ts": "export function save() {}\nexport function secret() {}",
        "consumer.ts":
            'import { save, secret } from "./shared"; export function allowed() { save() } export function denied() { secret() }',
    })
    const record = taskRecord({
        owns: [{ path: "consumer.ts", kind: "module" }],
        lines: [
            "%% kind: structure",
            "%% artifact: Consumer role=declaration path=consumer.ts",
            "%% artifact: Allowed role=declaration path=consumer.ts symbol=allowed",
            "%% artifact: Target role=receiver path=shared.ts symbol=save",
            "Consumer[Consumer]",
            "Allowed[Allowed] -->|uses| Target[Target]",
        ],
    })
    const findings = await run(root, [record])
    assert.ok(findings.some((item) => item.rule === "actual-edge-unverifiable"))
    const snapshot = await buildDependencyClosure({ repoRoot: root, seeds: ["consumer.ts"] })
    const edge = snapshot.imports.find((entry) => entry.importer === "consumer.ts")
    const declaration = declaredCounterparts(record).find((entry) => entry.origin === "diagram:Allowed->Target")
    assert.equal(counterpartAllows(declaration, { edge }, { codeSnapshot: snapshot }).state, "unverifiable")
    // Even a whole-target declaration is restricted to the emitting function's used bindings.
    assert.notEqual(
        counterpartAllows({ ...declaration, kind: "module", selector: null }, { edge }, { codeSnapshot: snapshot }).state,
        "allowed",
    )
    record.contracts = [{ path: "shared.ts", kind: "whole_file" }]
    assert.ok((await run(root, [record])).some((item) => item.rule === "actual-edge-unverifiable"))
})
