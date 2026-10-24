import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { canonicalNodeKey, normalizeArchitectureIdentity, resolveArchitectureNode } from "../lib/architecture-identity.mjs"
import { checkTaskHorizontally } from "../lib/checks-b3.mjs"
import {
    boundaryRelation,
    checkCodeConformance,
    classifyArtifactSymbol,
    classifyExpectationMismatch,
    findAuthorityConflicts,
    findBoundaryConflicts,
    proveEvidenceEdge,
} from "../lib/checks-code-conformance.mjs"
import { checkDependsOnReachability } from "../lib/checks-depends.mjs"
import { parseArchitectureEvidence, validateEvidenceAgainstDiagram } from "../lib/evidence-model.mjs"
import { parseFlowchart } from "../lib/mermaid-parse.mjs"

function diagram(source, file = "plan.md") {
    const parsed = parseFlowchart(source.trim().split(/\r?\n/), { file, firstLine: 1 })
    assert.deepEqual(parsed.problems, [])
    return parsed.diagram
}

function importEdge(importer, target, { typeOnly = false } = {}) {
    return {
        importer,
        importerAbsolute: `/repo/${importer}`,
        project: "root",
        specifier: `./${target}`,
        kind: "import",
        typeOnly,
        bindings: [],
        line: 1,
        target: {
            kind: "workspace",
            path: target,
            absolute: `/repo/${target}`,
            project: "root",
        },
    }
}

test("uses NFKC Unicode identity and reports same-priority ambiguity instead of guessing", () => {
    assert.equal(normalizeArchitectureIdentity(" Ａ—订单_处理器 "), "a订单处理器")
    assert.equal(normalizeArchitectureIdentity("Cafe\u0301"), normalizeArchitectureIdentity("Café"))

    const coarse = diagram(`
flowchart LR
    First[Café]
    Second[Cafe\u0301]
`)
    const fine = diagram(`
flowchart LR
    Target[ＣＡＦÉ]
`)
    const resolution = resolveArchitectureNode(fine.nodes.get("Target"), coarse, fine)
    assert.equal(resolution.node, null)
    assert.equal(resolution.strategy, "ambiguous-label")
    assert.deepEqual(
        resolution.candidates.map((node) => node.id),
        ["First", "Second"],
    )
    assert.equal(canonicalNodeKey(coarse, "First"), canonicalNodeKey(coarse, "Second"))
})

test("collects repeatable artifact annotations and keeps invalid node, role and expectation as actionable findings", () => {
    const parsed = parseFlowchart(
        [
            "flowchart LR",
            "    %% artifact: Service role=declaration path=src/service.ts symbol=Service expect=present",
            "    %% artifact: Service role=writer path=src/service.ts symbol=save expect=present",
            "    %% artifact: Missing role=reader path=src/missing.ts expect=present",
            "    %% artifact: Service role=owner path=src/service.ts expect=present",
            "    %% artifact: Service role=reader path=src/service.ts expect=sometimes",
            "    Service[Service] -->|hands| Ready[Ready]",
        ],
        { file: "plan.md", firstLine: 1 },
    )
    assert.deepEqual(parsed.problems, [])
    assert.equal(parsed.diagram.artifacts.get("Service").length, 4)
    assert.deepEqual(parsed.diagram.annotationFindings.map((finding) => finding.rule).sort(), [
        "artifact-expectation-unknown",
        "artifact-node-unknown",
        "artifact-role-unknown",
    ])
})

test("parses schema-v2 Architecture Evidence with stable artifact and endpoint identity", () => {
    const markdown = `# TASK Plan

## Architecture Evidence

\`\`\`yaml
architecture_evidence:
  schema_version: 2
  diagram_id: TASK-evidence
  nodes:
    Source:
      artifacts:
        - {id: source-emitter, role: emitter, path: src/source.ts, symbol: emit, expectation: present}
        - {id: source-declaration, role: declaration, path: src/source.ts, symbol: Source, expectation: present}
    Target:
      artifacts:
        - {id: target-receiver, role: receiver, path: src/target.ts, symbol: receive, expectation: present}
  edges:
    - id: TASK-evidence/Source/hands/Target
      from: Source
      to: Target
      style: solid
      label: hands
      kind: direct_import
      emit: {node: Source, artifact: source-emitter}
      receive: {node: Target, artifact: target-receiver}
      proof: [VER-EDGE]
\`\`\`
`
    const parsed = parseArchitectureEvidence(markdown, "plan.md")
    assert.deepEqual(parsed.problems, [])
    assert.equal(parsed.evidence.schemaVersion, 2)
    assert.equal(parsed.evidence.artifactById.get("source-emitter").node, "Source")
    assert.equal(parsed.evidence.edges[0].emit.path, "src/source.ts")
    assert.equal(parsed.evidence.edges[0].receive.role, "receiver")

    const targetDiagram = diagram(`
flowchart LR
    %% id: TASK-evidence
    Source[Source] -->|hands| Target[Target]
`)
    assert.deepEqual(validateEvidenceAgainstDiagram(parsed.evidence, targetDiagram), [])

    parsed.evidence.edges[0].label = "writes"
    assert.deepEqual(
        validateEvidenceAgainstDiagram(parsed.evidence, targetDiagram).map((finding) => finding.rule),
        ["evidence-edge-mismatch"],
    )

    const legacy = parseArchitectureEvidence(
        "## Architecture Evidence\n\n```yaml\narchitecture_evidence: {schema_version: 1, diagram_id: legacy}\n```\n",
        "legacy.md",
    )
    assert.deepEqual(
        legacy.problems.map((entry) => entry.rule),
        ["architecture-evidence-legacy-schema"],
    )

    const duplicate = parseArchitectureEvidence(
        `${markdown}\n## Architecture Evidence\n\n\`\`\`yaml\narchitecture_evidence: {schema_version: 2}\n\`\`\`\n`,
        "plan.md",
    )
    assert.deepEqual(
        duplicate.problems.map((entry) => entry.rule),
        ["architecture-evidence-duplicate"],
    )
})

test("rejects endpoint identities that drift from artifact nodes and roles", () => {
    const parsed = parseArchitectureEvidence(
        `## Architecture Evidence

\`\`\`yaml
architecture_evidence:
  schema_version: 2
  diagram_id: TASK-invalid
  nodes:
    Source:
      artifacts:
        - {id: source-emitter, role: emitter, path: src/source.ts, expectation: present}
    Target:
      artifacts:
        - {id: source-emitter, role: receiver, path: src/duplicate.ts, expectation: present}
        - {id: target-declaration, role: declaration, path: src/target.ts, expectation: present}
  edges:
    - id: invalid-edge
      from: Source
      to: Target
      style: solid
      label: hands
      kind: direct_import
      emit: {node: Target, artifact: source-emitter}
      receive: {node: Target, artifact: target-declaration, path: src/other.ts}
      assembly: {node: Target, artifact: missing-assembly}
      proof: [VER-EDGE]
    - id: reused-edge
      from: Source
      to: Target
      style: solid
      label: hands
      kind: direct_import
      emit: {node: Source, artifact: source-emitter}
      receive: {node: Source, artifact: source-emitter}
      proof: [VER-EDGE]
\`\`\`
`,
        "invalid.md",
    )
    const rules = new Set(parsed.problems.map((entry) => entry.rule))
    assert.equal(rules.has("artifact-id-duplicate"), true)
    assert.equal(rules.has("evidence-endpoint-artifact-unknown"), true)
    assert.equal(rules.has("evidence-endpoint-artifact-node-mismatch"), true)
    assert.equal(rules.has("evidence-edge-emit-node-mismatch"), true)
    assert.equal(rules.has("evidence-edge-receive-node-mismatch"), true)
    assert.equal(rules.has("evidence-endpoint-role-mismatch"), true)
    assert.equal(rules.has("evidence-endpoint-inline-location"), true)
    assert.equal(rules.has("evidence-edge-endpoint-artifact-reused"), true)
    assert.equal(rules.has("evidence-edge-endpoint-location-reused"), true)
})

test("legacy evidence cannot establish completed conformance", async () => {
    const legacy = parseArchitectureEvidence(
        "## Architecture Evidence\n\n```yaml\narchitecture_evidence: {schema_version: 1, diagram_id: legacy}\n```\n",
        "legacy.md",
    )
    const task = {
        id: "TASK-LEGACY",
        status: "completed",
        owns: [],
        reads: [],
        diagrams: [],
        architectureEvidence: legacy.evidence,
        evidenceProblems: legacy.problems,
        requiredVerification: new Map(),
        verification: [],
        planPath: "legacy.md",
        goalsPath: "goals.yaml",
    }
    const findings = await checkCodeConformance({
        spec: { diagrams: [] },
        tasks: new Map([[task.id, task]]),
        repoRoot: process.cwd(),
        codeSnapshot: { imports: [], protoServices: [], diagnostics: [], generated: [] },
    })
    assert.equal(
        findings.some(
            (entry) =>
                entry.rule === "architecture-evidence-legacy-schema" &&
                entry.severity === "blocking" &&
                entry.attribution === "record",
        ),
        true,
    )
})

test("artifact ids are unique across the current Workstream", async () => {
    const artifact = (node, artifactPath) => ({
        id: "shared-artifact",
        node,
        role: "declaration",
        path: artifactPath,
        symbol: null,
        expectation: "present",
        canonicalSource: null,
        provenance: null,
    })
    const makeTask = (id, node, artifactPath) => {
        const record = artifact(node, artifactPath)
        return {
            id,
            status: "completed",
            owns: [],
            reads: [],
            diagrams: [],
            architectureEvidence: {
                schemaVersion: 2,
                diagramId: `${id}-diagram`,
                nodes: new Map([[node, { artifacts: [record] }]]),
                artifactById: new Map([[record.id, record]]),
                edges: [],
                file: `${id}.md`,
            },
            evidenceProblems: [],
            requiredVerification: new Map(),
            verification: [],
            planPath: `${id}.md`,
            goalsPath: `${id}.yaml`,
        }
    }
    const findings = await checkCodeConformance({
        spec: { diagrams: [] },
        tasks: new Map([
            ["TASK-A", makeTask("TASK-A", "A", "src/a.ts")],
            ["TASK-B", makeTask("TASK-B", "B", "src/b.ts")],
        ]),
        repoRoot: process.cwd(),
        codeSnapshot: { imports: [], protoServices: [], diagnostics: [], generated: [] },
    })
    assert.equal(
        findings.some((entry) => entry.rule === "evidence-artifact-id-duplicate" && entry.severity === "blocking"),
        true,
    )
})

test("detects an arbitrary-length SCC formed only after three task diagrams are merged", () => {
    const entries = [
        { taskId: "TASK-A", diagram: diagram("flowchart LR\nA[A] -->|hands| B[B]", "a.md") },
        { taskId: "TASK-B", diagram: diagram("flowchart LR\nB[B] -->|hands| C[C]", "b.md") },
        { taskId: "TASK-C", diagram: diagram("flowchart LR\nC[C] -->|hands| A[A]", "c.md") },
    ]
    const cycles = checkTaskHorizontally({ entries }).filter((finding) => finding.rule === "cross-task-cycle")
    assert.equal(cycles.length, 1)
    assert.match(cycles[0].message, /TASK-A.*TASK-B.*TASK-C|TASK-A.*TASK-C.*TASK-B/)
})

test("excludes task-local and note nodes from horizontal dependency cycles", () => {
    const entries = [
        {
            taskId: "TASK-A",
            diagram: diagram("flowchart LR\n%% local-only: B\nA[A] -->|local step| B[B]", "a.md"),
        },
        {
            taskId: "TASK-B",
            diagram: diagram("flowchart LR\n%% note-node: C\nB[B] -->|visible constraint| C[C]", "b.md"),
        },
        {
            taskId: "TASK-C",
            diagram: diagram("flowchart LR\n%% local-only: C\nC[C] -->|local step| A[A]", "c.md"),
        },
    ]
    const cycles = checkTaskHorizontally({ entries }).filter((finding) => finding.rule === "cross-task-cycle")
    assert.equal(cycles.length, 0)
})

test("requires a nonzero Workstream path between artifact-owned upstream and downstream nodes", () => {
    const ws = diagram("flowchart LR\nA[A] -->|hands| B[B]", "spec.md")
    const upstreamDiagram = diagram(
        `
flowchart LR
    %% artifact: A role=writer path=src/a.ts expect=present
    A[A]
`,
        "upstream.md",
    )
    const downstreamSameNode = diagram(
        `
flowchart LR
    %% artifact: A role=reader path=src/downstream.ts expect=present
    A[A]
`,
        "downstream.md",
    )
    const downstreamReachable = diagram(
        `
flowchart LR
    %% artifact: B role=reader path=src/downstream.ts expect=present
    B[B]
`,
        "downstream.md",
    )
    const planGraph = {
        error: null,
        tasks: [{ id: "TASK-B", dependsOn: ["TASK-A"], line: 2 }],
    }
    const task = (id, owns, taskDiagram) => ({ id, owns, diagrams: [{ problems: [], diagram: taskDiagram }] })

    let findings = checkDependsOnReachability({
        tasks: new Map([
            ["TASK-A", task("TASK-A", [{ path: "src/a.ts", kind: "module", selector: null }], upstreamDiagram)],
            ["TASK-B", task("TASK-B", [{ path: "src/downstream.ts", kind: "module", selector: null }], downstreamSameNode)],
        ]),
        planGraph,
        wsDiagrams: [ws],
        planPath: "plan.md",
    })
    assert.equal(
        findings.some((finding) => finding.rule === "depends-on-not-explained-by-diagram"),
        true,
    )

    findings = checkDependsOnReachability({
        tasks: new Map([
            ["TASK-A", task("TASK-A", [{ path: "src/a.ts", kind: "module", selector: null }], upstreamDiagram)],
            ["TASK-B", task("TASK-B", [{ path: "src/downstream.ts", kind: "module", selector: null }], downstreamReachable)],
        ]),
        planGraph,
        wsDiagrams: [ws],
        planPath: "plan.md",
    })
    assert.equal(
        findings.some((finding) => finding.rule === "depends-on-not-explained-by-diagram"),
        false,
    )
})

test("classifies present, absent and generated expectations by task completion state", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-conformance-expectation-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.writeFileSync(path.join(root, "src/generated.ts"), "export const generated = true\n")

    const taskDiagram = diagram(`
flowchart LR
    %% id: TASK-expectation
    Artifact[Artifact]
`)
    const evidence = {
        schemaVersion: 1,
        diagramId: "TASK-expectation",
        file: "plan.md",
        nodes: new Map([
            [
                "Artifact",
                {
                    artifacts: [
                        { role: "declaration", path: "src/missing.ts", symbol: null, expectation: "present" },
                        { role: "declaration", path: "src/deleted.ts", symbol: null, expectation: "absent" },
                        {
                            role: "generated",
                            path: "src/generated.ts",
                            symbol: null,
                            expectation: "generated",
                            canonicalSource: "proto/demo.proto",
                            provenance: "generator",
                        },
                    ],
                },
            ],
        ]),
        edges: [],
    }
    const makeTask = (status) => ({
        id: "TASK-X",
        status,
        owns: [],
        reads: [],
        diagrams: [{ problems: [], diagram: taskDiagram }],
        architectureEvidence: evidence,
        evidenceProblems: [],
        requiredVerification: new Map(),
        verification: [],
        planPath: "plan.md",
        goalsPath: "goals.yaml",
    })
    const codeSnapshot = {
        imports: [],
        protoServices: [],
        diagnostics: [],
        generated: [
            {
                path: "src/generated.ts",
                state: "present",
                canonicalSource: "proto/demo.proto",
            },
        ],
    }
    const run = (status) =>
        checkCodeConformance({
            spec: { diagrams: [] },
            tasks: new Map([["TASK-X", makeTask(status)]]),
            repoRoot: root,
            codeSnapshot,
        })

    let findings = await run("active")
    assert.deepEqual(
        findings.filter((finding) => finding.rule === "artifact-expectation-mismatch").map((finding) => finding.severity),
        ["warning"],
    )
    findings = await run("completed")
    assert.deepEqual(
        findings.filter((finding) => finding.rule === "artifact-expectation-mismatch").map((finding) => finding.severity),
        ["blocking"],
    )
})

test("blocks completed runtime reversal and SCC while leaving type-only relations nonblocking", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-conformance-runtime-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    for (const file of ["a.ts", "b.ts", "c.ts"]) fs.writeFileSync(path.join(root, "src", file), "export {}\n")

    const taskDiagram = diagram(`
flowchart LR
    %% id: TASK-runtime
    A[A] -->|hands| B[B]
`)
    const evidence = {
        schemaVersion: 1,
        diagramId: "TASK-runtime",
        file: "plan.md",
        nodes: new Map(),
        edges: [
            {
                id: "runtime/A/hands/B",
                from: "A",
                to: "B",
                style: "solid",
                label: "hands",
                kind: "direct_import",
                emit: { path: "src/a.ts", symbol: null },
                receive: { path: "src/b.ts", symbol: null },
                contract: null,
                assembly: null,
                rpc: null,
                proof: ["VER-RUNTIME"],
            },
        ],
    }
    const task = {
        id: "TASK-RUNTIME",
        status: "completed",
        owns: [
            { path: "src/a.ts", kind: "module", selector: null },
            { path: "src/b.ts", kind: "module", selector: null },
            { path: "src/c.ts", kind: "module", selector: null },
        ],
        reads: [],
        diagrams: [{ problems: [], diagram: taskDiagram }],
        architectureEvidence: evidence,
        evidenceProblems: [],
        requiredVerification: new Map([["VER-RUNTIME", { requiredResult: "passed", claim: "runtime direction" }]]),
        verification: [{ check: "VER-RUNTIME", result: "passed", conclusion: "fixture" }],
        planPath: "plan.md",
        goalsPath: "goals.yaml",
    }
    const codeSnapshot = {
        imports: [
            importEdge("src/b.ts", "src/a.ts"),
            importEdge("src/a.ts", "src/c.ts"),
            importEdge("src/c.ts", "src/b.ts"),
            importEdge("src/a.ts", "src/b.ts", { typeOnly: true }),
        ],
        protoServices: [],
        diagnostics: [],
        generated: [],
    }
    const findings = await checkCodeConformance({
        spec: { diagrams: [] },
        tasks: new Map([[task.id, task]]),
        repoRoot: root,
        codeSnapshot,
    })
    assert.equal(
        findings.some((finding) => finding.rule === "runtime-edge-direction-contradiction" && finding.severity === "blocking"),
        true,
    )
    const runtimeScc = findings.filter((finding) => finding.rule === "runtime-scc")
    assert.equal(runtimeScc.length, 1)
    assert.equal(runtimeScc[0].severity, "blocking")
})

test("uses the Skill-local Tree-sitter closure without a target tsconfig", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-conformance-tree-sitter-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.writeFileSync(
        path.join(root, "src/a.ts"),
        'import { b } from "./b"\nimport type { Shape } from "./types"\nexport const a: Shape = b()\n',
    )
    fs.writeFileSync(path.join(root, "src/b.ts"), 'import { c } from "./c"\nexport function b(){ return c() }\n')
    fs.writeFileSync(path.join(root, "src/c.ts"), 'import { a } from "./a"\nexport function c(){ return a }\n')
    fs.writeFileSync(path.join(root, "src/types.ts"), "export type Shape = number\n")

    const task = {
        id: "TASK-TREE-SITTER",
        status: "completed",
        owns: ["a.ts", "b.ts", "c.ts", "types.ts"].map((file) => ({ path: `src/${file}`, kind: "module", selector: null })),
        reads: [],
        diagrams: [],
        architectureEvidence: null,
        evidenceProblems: [],
        requiredVerification: new Map(),
        verification: [],
        planPath: "plan.md",
        goalsPath: "goals.yaml",
    }
    const findings = await checkCodeConformance({
        spec: { diagrams: [] },
        tasks: new Map([[task.id, task]]),
        repoRoot: root,
    })

    assert.equal(
        findings.some((finding) => finding.rule === "runtime-scc" && finding.severity === "blocking"),
        true,
    )
    assert.equal(
        findings.some((finding) => finding.rule === "code-fact-diagnostic" && /typescript|tsconfig/i.test(finding.message)),
        false,
    )
    assert.equal(
        findings.some(
            (finding) =>
                finding.rule === "actual-edge-undeclared" &&
                finding.file === "src/a.ts" &&
                /types\.ts/.test(finding.message) &&
                /runtime/.test(finding.message),
        ),
        false,
    )
})

test("separates expectation, explicit authority and owned-boundary severity from write permission", () => {
    assert.equal(classifyExpectationMismatch("completed"), "blocking")
    assert.equal(classifyExpectationMismatch("active"), "warning")
    assert.equal(classifyExpectationMismatch("blocked"), "warning")

    const authority = findAuthorityConflicts([
        { taskId: "TASK-A", status: "completed", fact: "canonical-state", writer: "WriterA", file: "a.md" },
        { taskId: "TASK-B", status: "completed", fact: "canonical-state", writer: "WriterB", file: "b.md" },
        { taskId: "TASK-C", status: "active", fact: "other-state", writer: "WriterC", file: "c.md" },
        { taskId: "TASK-D", status: "completed", fact: "other-state", writer: "WriterD", file: "d.md" },
    ])
    assert.equal(authority.find((finding) => finding.message.includes("canonical-state"))?.severity, "blocking")
    assert.equal(authority.find((finding) => finding.message.includes("other-state"))?.severity, "warning")

    assert.equal(
        boundaryRelation(
            { path: "SRC/State.ts", kind: "module", selector: null },
            { path: "src/state.ts", kind: "symbol", selector: "save" },
        ).relation,
        "overlap",
    )
    assert.equal(
        boundaryRelation(
            { path: "src/state.ts", kind: "symbol", selector: "read" },
            { path: "src/state.ts", kind: "symbol", selector: "save" },
        ).relation,
        "disjoint",
    )
    assert.equal(
        boundaryRelation(
            { path: "src/state.ts", kind: "section", selector: "Persistence" },
            { path: "src/state.ts", kind: "symbol", selector: "save" },
        ).relation,
        "unknown",
    )

    const boundary = findBoundaryConflicts([
        {
            taskId: "TASK-A",
            status: "completed",
            boundaries: [{ path: "src/state.ts", kind: "module", selector: null }],
        },
        {
            taskId: "TASK-B",
            status: "completed",
            boundaries: [{ path: "src/state.ts", kind: "symbol", selector: "save" }],
        },
        {
            taskId: "TASK-C",
            status: "completed",
            boundaries: [{ path: "src/state.ts", kind: "section", selector: "Persistence" }],
        },
    ])
    assert.equal(
        boundary.some((finding) => finding.rule === "owned-boundary-overlap" && finding.severity === "blocking"),
        true,
    )
    assert.equal(
        boundary.some((finding) => finding.rule === "owned-boundary-unverifiable" && finding.severity === "warning"),
        true,
    )
})

test("proves only observable wiring and marks semantic adapters unverifiable", () => {
    const codeSnapshot = {
        imports: [
            importEdge("src/direct.ts", "src/target.ts"),
            importEdge("src/producer.ts", "src/port.ts", { typeOnly: true }),
            importEdge("src/consumer.ts", "src/port.ts", { typeOnly: true }),
            importEdge("src/assembly.ts", "src/producer.ts"),
            importEdge("src/assembly.ts", "src/consumer.ts"),
            importEdge("src/emitter.ts", "src/event.ts"),
            importEdge("src/receiver.ts", "src/event.ts"),
            importEdge("src/caller.ts", "src/callback.ts", { typeOnly: true }),
            importEdge("src/callee.ts", "src/callback.ts", { typeOnly: true }),
        ],
        protoServices: [
            {
                fullName: "demo.v1.DemoService",
                methods: [{ name: "ping" }],
            },
        ],
        generated: [],
        diagnostics: [],
    }
    const presentArtifacts = new Set([
        "src/direct.ts",
        "src/target.ts",
        "src/producer.ts",
        "src/consumer.ts",
        "src/assembly.ts",
        "src/port.ts",
        "src/emitter.ts",
        "src/receiver.ts",
        "src/event.ts",
        "src/caller.ts",
        "src/callee.ts",
        "src/callback.ts",
        "src/rpc-client.ts",
        "src/rpc-server.ts",
    ])
    const endpoint = (path) => ({ path })
    const cases = [
        {
            kind: "direct_import",
            emit: endpoint("src/direct.ts"),
            receive: endpoint("src/target.ts"),
        },
        {
            kind: "injected_port",
            emit: endpoint("src/producer.ts"),
            receive: endpoint("src/consumer.ts"),
            contract: endpoint("src/port.ts"),
        },
        {
            kind: "composition",
            emit: endpoint("src/producer.ts"),
            receive: endpoint("src/consumer.ts"),
            assembly: endpoint("src/assembly.ts"),
        },
        {
            kind: "event",
            emit: endpoint("src/emitter.ts"),
            receive: endpoint("src/receiver.ts"),
            contract: endpoint("src/event.ts"),
        },
        {
            kind: "callback",
            emit: endpoint("src/caller.ts"),
            receive: endpoint("src/callee.ts"),
            contract: endpoint("src/callback.ts"),
        },
        {
            kind: "rpc",
            emit: endpoint("src/rpc-client.ts"),
            receive: endpoint("src/rpc-server.ts"),
            rpc: { service: "demo.v1.DemoService", method: "ping" },
        },
    ]

    const expectedStatus = new Map([
        ["direct_import", "proven"],
        ["injected_port", "unverifiable"],
        ["composition", "proven"],
        ["event", "unverifiable"],
        ["callback", "unverifiable"],
        ["rpc", "unverifiable"],
    ])
    for (const edge of cases) {
        const proof = proveEvidenceEdge({ edge, codeSnapshot, presentArtifacts })
        assert.equal(proof.status, expectedStatus.get(edge.kind), `${edge.kind}: ${proof.reason}`)
        assert.equal(proof.proven, proof.status === "proven")
        assert.equal(proof.adapter, edge.kind)
    }

    const receiveAsCompositionRoot = proveEvidenceEdge({
        edge: {
            kind: "composition",
            emit: endpoint("src/producer.ts"),
            receive: endpoint("src/assembly.ts"),
        },
        codeSnapshot,
        presentArtifacts,
    })
    assert.equal(receiveAsCompositionRoot.proven, true, receiveAsCompositionRoot.reason)

    const missing = proveEvidenceEdge({
        edge: { kind: "direct_import", emit: endpoint("src/producer.ts"), receive: endpoint("src/target.ts") },
        codeSnapshot,
        presentArtifacts,
    })
    assert.equal(missing.status, "contradicted")
})

test("reports semantic edge prerequisites as unverifiable instead of proven", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-conformance-semantic-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    for (const file of ["emitter.ts", "receiver.ts", "event.ts"]) {
        fs.writeFileSync(path.join(root, "src", file), "export {}\n")
    }
    const taskDiagram = diagram(`
flowchart LR
    %% id: TASK-semantic
    E[Emitter] -->|publishes| R[Receiver]
`)
    const artifacts = [
        { id: "emitter", node: "E", role: "emitter", path: "src/emitter.ts", symbol: null, expectation: "present" },
        { id: "receiver", node: "R", role: "receiver", path: "src/receiver.ts", symbol: null, expectation: "present" },
        { id: "event", node: "E", role: "declaration", path: "src/event.ts", symbol: null, expectation: "present" },
    ]
    const evidence = {
        schemaVersion: 2,
        diagramId: "TASK-semantic",
        file: "plan.md",
        nodes: new Map([
            ["E", { artifacts: [artifacts[0], artifacts[2]] }],
            ["R", { artifacts: [artifacts[1]] }],
        ]),
        artifactById: new Map(artifacts.map((artifact) => [artifact.id, artifact])),
        edges: [
            {
                id: "TASK-semantic/E/publishes/R",
                from: "E",
                to: "R",
                style: "solid",
                label: "publishes",
                kind: "event",
                emit: { ...artifacts[0], artifactId: "emitter" },
                receive: { ...artifacts[1], artifactId: "receiver" },
                contract: { ...artifacts[2], artifactId: "event" },
                assembly: null,
                rpc: null,
                proof: ["VER-EVENT"],
            },
        ],
    }
    const task = {
        id: "TASK-SEMANTIC",
        status: "completed",
        owns: [],
        reads: [],
        diagrams: [{ problems: [], diagram: taskDiagram }],
        architectureEvidence: evidence,
        evidenceProblems: [],
        requiredVerification: new Map([["VER-EVENT", { requiredResult: "passed", claim: "event delivery" }]]),
        verification: [{ check: "VER-EVENT", result: "passed", conclusion: "fixture" }],
        planPath: "plan.md",
        goalsPath: "goals.yaml",
    }
    const findings = await checkCodeConformance({
        spec: { diagrams: [] },
        tasks: new Map([[task.id, task]]),
        repoRoot: root,
        codeSnapshot: {
            imports: [
                importEdge("src/emitter.ts", "src/event.ts", { typeOnly: true }),
                importEdge("src/receiver.ts", "src/event.ts", { typeOnly: true }),
            ],
            protoServices: [],
            generated: [],
            diagnostics: [],
        },
    })
    assert.equal(
        findings.some((finding) => finding.rule === "edge-wiring-unverifiable" && finding.severity === "unverifiable"),
        true,
    )
    assert.equal(
        findings.some((finding) => finding.rule === "edge-wiring-contradiction"),
        false,
    )
})

test("uses declaration facts as positive symbol evidence without inferring absence", () => {
    const codeSnapshot = {
        treeSitterFacts: [
            {
                path: "src/service.ts",
                category: "declarations",
                capture: "name.definition.class",
                text: "Service",
            },
        ],
    }
    assert.equal(
        classifyArtifactSymbol({ artifact: { path: "src/service.ts", symbol: "Service" }, codeSnapshot }).status,
        "proven",
    )
    assert.equal(
        classifyArtifactSymbol({ artifact: { path: "src/service.ts", symbol: "service" }, codeSnapshot }).status,
        "unverifiable",
    )
    assert.equal(
        classifyArtifactSymbol({ artifact: { path: "schema.proto", symbol: "Service" }, codeSnapshot }).status,
        "unverifiable",
    )
})
