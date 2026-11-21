import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { dedupeFindings, scopeSequence } from "../lib/invocation.mjs"
import { computeExitCode, computeVerdict, renderJsonReport, renderTextReport } from "../lib/report.mjs"
import { readArchitectureMode } from "../lib/ws-model.mjs"

const exact = "# WS-001 Example\n\nArchitecture-Mode: diagram-driven-v1\n\n## Goal\n"
const verifierPath = fileURLToPath(new URL("../verify-diagrams.mjs", import.meta.url))

function createFixture(t, specText) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-architecture-admission-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const workstreamsDir = path.join(root, ".memory-bank", "workstreams")
    const target = path.join(workstreamsDir, "WS-TEST-target")
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, "spec.md"), specText)
    return { root, target, workstreamsDir }
}

function runVerifier({ root, target, preload = null, forbidden = [], cliArgs = ["--no-self-test"] }) {
    const args = []
    if (preload) args.push("--import", pathToFileURL(preload).href)
    args.push(verifierPath, "--workstream", target, "--json", ...cliArgs)
    return spawnSync(process.execPath, args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, DLINE_TEST_FORBIDDEN_PATHS: JSON.stringify(forbidden) },
    })
}

test("admits only the exact first body-line marker", () => {
    assert.deepEqual(readArchitectureMode(exact), { state: "admitted", mode: "diagram-driven-v1", line: 3 })
    assert.equal(readArchitectureMode("# WS-001 Example\n\n## Goal\n").state, "not-applicable")
    assert.deepEqual(readArchitectureMode("# WS-001 Example\n\nArchitecture-Mode: diagram-driven-v2\n"), {
        state: "unsupported",
        mode: "diagram-driven-v2",
        line: 3,
    })
    assert.equal(readArchitectureMode("# WS-001 Example\n\n## Goal\n\nArchitecture-Mode: diagram-driven-v1\n").state, "tooling")
    assert.equal(readArchitectureMode(`${exact}\nArchitecture-Mode: diagram-driven-v1\n`).state, "tooling")
    assert.equal(readArchitectureMode("# WS-001 Example\n   \nArchitecture-Mode: diagram-driven-v1\n").state, "admitted")
    assert.equal(readArchitectureMode("# WS-001 Example\n\nArchitecture-Mode: diagram-driven-v1 \n").state, "tooling")
    assert.equal(readArchitectureMode("# WS-001 Example\n\n Architecture-Mode: diagram-driven-v1\n").state, "tooling")
    assert.equal(
        readArchitectureMode("# WS-001 Example\n\n```text\nArchitecture-Mode: diagram-driven-v1\n```\n").state,
        "not-applicable",
    )
})

test("plans one aggregate sequence without omitting tasks", () => {
    const scopes = scopeSequence("all", ["TASK-2", "TASK-1"])
    assert.deepEqual(scopes, ["workstream", "task:TASK-1", "task:TASK-2", "cross-task", "code-conformance"])
    assert.equal(scopes.filter((scope) => scope === "code-conformance").length, 1)
    assert.deepEqual(scopeSequence("task:TASK-1", ["TASK-1"]), ["task:TASK-1"])
})

test("deduplicates aggregate findings by stable identity", () => {
    const finding = {
        severity: "warning",
        attribution: "diagram",
        stage: "6",
        rule: "x",
        task: "T",
        file: "a",
        line: 1,
        message: "m",
    }
    assert.deepEqual(dedupeFindings([finding, { ...finding }]), [finding])
})

test("keeps exit code and verdict orthogonal", () => {
    assert.equal(computeExitCode([]), 0)
    assert.equal(computeVerdict([], { applicable: true }), "conformant")
    assert.equal(computeVerdict([], { applicable: true, coverageComplete: false }), "incomplete")
    assert.equal(computeVerdict([{ severity: "warning", attribution: "diagram" }], { applicable: true }), "incomplete")
    assert.equal(computeVerdict([], { applicable: false }), "not_applicable")
    assert.equal(computeVerdict([{ severity: "blocking", attribution: "diagram" }], { applicable: true }), "failed")
    assert.equal(computeVerdict([{ severity: "tooling", attribution: "tooling" }], { applicable: true }), "tooling_error")
})

test("CLI exit status includes contracts after block scalars and rejects truncated input", (t) => {
    const fixture = createFixture(
        t,
        "# WS-TEST Target\n\nArchitecture-Mode: diagram-driven-v1\n\nArrow labels are normative: `owns`.\n",
    )
    const taskDir = path.join(fixture.target, "tasks", "TASK-001-example")
    fs.mkdirSync(taskDir, { recursive: true })
    const goals = path.join(taskDir, "goals.yaml")
    const progress = path.join(taskDir, "progress.md")
    fs.writeFileSync(
        goals,
        "id: TASK-001\nobjective: >-\n  A folded objective.\nrequired_verification:\n  VER-ONE:\n    required_result: passed\n    claim: >-\n      Required behavior.\n",
    )
    fs.writeFileSync(progress, "---\nstatus: completed\nverification: []\n---\n")
    const cliArgs = ["--scope", "workstream", "--no-self-test"]
    let result = runVerifier({ ...fixture, cliArgs })
    let report = JSON.parse(result.stdout)
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.equal(report.exitCode, 1)
    assert.equal(
        report.findings.some(
            (finding) => finding.rule === "completed_without_required_verification" && finding.task === "TASK-001",
        ),
        true,
    )

    fs.writeFileSync(
        progress,
        "---\nstatus: completed\nverification:\n  - check: VER-ONE\n    result: passed\n    conclusion: Observed the required behavior.\n---\n",
    )
    result = runVerifier({ ...fixture, cliArgs })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(JSON.parse(result.stdout).exitCode, 0)

    fs.writeFileSync(goals, "id: TASK-001\nobjective: plain\n  hidden: invalid indentation\n")
    result = runVerifier({ ...fixture, cliArgs })
    report = JSON.parse(result.stdout)
    assert.equal(result.status, 2, result.stderr || result.stdout)
    assert.equal(report.exitCode, 2)
    assert.equal(report.verdict, "tooling_error")
})

test("all counts a validated Task refinement while workstream scope cannot borrow it", (t) => {
    const fixture = createFixture(
        t,
        `${exact}\nArrow labels are normative: \`injects\`.\n
\`\`\`mermaid
flowchart LR
%% id: parent
%% layer: L0
%% kind: structure
%% answers: ownership
A[A] -->|injects| B[B]
\`\`\`
\`\`\`mermaid
flowchart LR
%% id: selective
%% layer: L1
%% kind: structure
%% refines: parent
%% answers: selective details
%% local-only: X
%% local-only: Y
A[A] -->|injects| X[X]
B[B] -->|injects| Y[Y]
\`\`\`
`,
    )
    const taskDir = path.join(fixture.target, "tasks", "TASK-001-example")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "goals.yaml"), "id: TASK-001\nrequired_verification: {}\n")
    fs.writeFileSync(path.join(taskDir, "progress.md"), "---\nstatus: planned\n---\n")
    const taskPlan = (parent, edge = "A[A] -->|injects| B[B]") =>
        `# Task\n\n## Architecture Design\n\n\`\`\`mermaid\nflowchart LR\n%% id: task-detail\n%% layer: L2\n%% kind: structure\n%% refines: ${parent}\n%% answers: task implementation\n${edge}\n\`\`\`\n`
    fs.writeFileSync(path.join(taskDir, "plan.md"), taskPlan("parent"))
    let result = runVerifier({ ...fixture, cliArgs: ["--scope", "workstream", "--no-self-test"] })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const focused = JSON.parse(result.stdout)
    assert.equal(focused.verdict, "incomplete")
    assert.equal(focused.findings.find((item) => item.rule === "coarse-edge-not-refined")?.severity, "warning")
    result = runVerifier(fixture)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(
        JSON.parse(result.stdout).findings.some((item) => item.rule === "coarse-edge-not-refined"),
        false,
    )
    for (const content of [taskPlan("missing"), taskPlan("parent", "A[A] -.->|result fact| B[B]")]) {
        fs.writeFileSync(path.join(taskDir, "plan.md"), content)
        result = runVerifier(fixture)
        assert.equal(result.status, 1)
        assert.equal(
            JSON.parse(result.stdout).findings.some((item) => item.rule === "coarse-edge-not-refined"),
            true,
        )
    }
})

test("reports unrefined boxes separately without losing or duplicating warning identities", () => {
    const findings = [
        {
            severity: "warning",
            attribution: "diagram",
            rule: "coarse-node-not-refined",
            file: "box.md",
            line: 10,
            message: "B needs detail",
        },
        {
            severity: "warning",
            attribution: "diagram",
            rule: "coarse-edge-not-refined",
            file: "edge.md",
            line: 20,
            message: "A to B needs detail",
        },
        {
            severity: "warning",
            attribution: "code",
            rule: "unfinished-expectation",
            file: "code.ts",
            line: 30,
            message: "Implementation pending",
        },
    ]
    const summary = {
        workstream: "ws",
        scope: "all",
        diagramCount: 2,
        taskDiagramCount: 0,
        taskCount: 1,
        astGatedCount: 0,
        staleProjections: [],
        verdict: computeVerdict(findings),
        exitCode: computeExitCode(findings),
    }
    const text = renderTextReport({ findings, summary })
    const warnings = text.split("## Warning\n")[1].split("## Pending\n")[0]
    const sections = warnings.split(/^### /m).slice(1)
    assert.equal(sections.length, 2)
    assert.deepEqual(
        sections[0].split("\n").filter((line) => line.startsWith("- ")),
        ["- coarse-node-not-refined · box.md:10", "- coarse-edge-not-refined · edge.md:20"],
    )
    assert.deepEqual(
        sections[1].split("\n").filter((line) => line.startsWith("- ")),
        ["- unfinished-expectation · code.ts:30"],
    )
    const report = JSON.parse(renderJsonReport({ findings, summary }))
    assert.equal(report.exitCode, 0)
    assert.equal(report.verdict, "incomplete")
    assert.equal(report.counts.warning, 3)
    assert.equal(report.counts.unverifiable, 0)
    assert.deepEqual(
        report.findings.map(({ rule, file, line }) => ({ rule, file, line })),
        [
            { rule: "coarse-node-not-refined", file: "box.md", line: 10 },
            { rule: "coarse-edge-not-refined", file: "edge.md", line: 20 },
            { rule: "unfinished-expectation", file: "code.ts", line: 30 },
        ],
    )
})

test("renders warning and not-applicable counts in JSON", () => {
    const findings = [
        { severity: "warning", attribution: "diagram", message: "warning" },
        { severity: "not-applicable", attribution: "diagram", message: "skip" },
    ]
    const json = JSON.parse(
        renderJsonReport({
            findings,
            summary: {
                workstream: "ws",
                scope: "all",
                diagramCount: 0,
                taskDiagramCount: 0,
                taskCount: 0,
                astGatedCount: 0,
                staleProjections: [],
                applicable: true,
                coverage: {
                    mode: "delivery",
                    complete: false,
                    requiredScopes: ["workstream", "cross-task", "code-conformance"],
                    executedScopes: ["workstream"],
                    missingScopes: ["cross-task", "code-conformance"],
                },
                evidence: { selfTest: { status: "skipped", message: "fixture" } },
                exitCode: 0,
                verdict: "incomplete",
            },
        }),
    )
    assert.equal(json.schemaVersion, 1)
    assert.equal(json.verdict, "incomplete")
    assert.equal(json.coverage.complete, false)
    assert.deepEqual(json.coverage.missingScopes, ["cross-task", "code-conformance"])
    assert.equal(json.evidence.selfTest.status, "skipped")
    assert.equal(json.evidence.metrics.taskCount, 0)
    assert.equal(json.counts.warning, 1)
    assert.equal(json.counts.notApplicable, 1)
})

test("short-circuits missing, unsupported and malformed modes with orthogonal verdicts", (t) => {
    const fixture = createFixture(t, "# WS-TEST Target\n\n## Goal\n")

    let result = runVerifier(fixture)
    assert.equal(result.status, 0, result.stderr)
    let report = JSON.parse(result.stdout)
    assert.equal(report.verdict, "not_applicable")
    assert.equal(report.counts.notApplicable, 1)

    fs.writeFileSync(path.join(fixture.target, "spec.md"), "# WS-TEST Target\n\nArchitecture-Mode: diagram-driven-v2\n")
    result = runVerifier(fixture)
    assert.equal(result.status, 0, result.stderr)
    report = JSON.parse(result.stdout)
    assert.equal(report.verdict, "incomplete")
    assert.equal(report.counts.warning, 1)

    fs.writeFileSync(path.join(fixture.target, "spec.md"), "# WS-TEST Target\n\nArchitecture-Mode: diagram-driven-v1 \n")
    result = runVerifier(fixture)
    assert.equal(result.status, 2, result.stderr)
    report = JSON.parse(result.stdout)
    assert.equal(report.verdict, "tooling_error")
    assert.equal(report.counts.tooling, 1)
})

test("focused scope and skipped self-test remain diagnostic even with exit zero", (t) => {
    const fixture = createFixture(
        t,
        "# WS-TEST Target\n\nArchitecture-Mode: diagram-driven-v1\n\nArrow labels are normative: `owns`.\n",
    )
    fs.writeFileSync(
        path.join(fixture.target, "plan.md"),
        "# WS-TEST Plan\n\n| Task | Goal Contract | Depends On | Execution Mode | Integration |\n|---|---|---|---|---|\n",
    )

    let result = runVerifier({ ...fixture, cliArgs: ["--scope", "workstream", "--no-self-test"] })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    let report = JSON.parse(result.stdout)
    assert.equal(report.verdict, "incomplete")
    assert.equal(report.coverage.mode, "diagnostic")
    assert.equal(report.coverage.complete, false)
    assert.deepEqual(report.coverage.executedScopes, ["workstream"])
    assert.equal(report.coverage.missingScopes.includes("code-conformance"), true)
    assert.equal(report.evidence.selfTest.status, "skipped")

    result = runVerifier(fixture)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    report = JSON.parse(result.stdout)
    assert.equal(report.coverage.mode, "delivery")
    assert.equal(report.coverage.complete, false)
    assert.equal(report.evidence.selfTest.status, "skipped")
})

test("default self-test is Skill-local positive evidence in a non-Node target", (t) => {
    const fixture = createFixture(
        t,
        "# WS-TEST Target\n\nArchitecture-Mode: diagram-driven-v1\n\nArrow labels are normative: `owns`.\n",
    )
    fs.writeFileSync(
        path.join(fixture.target, "plan.md"),
        "# WS-TEST Plan\n\n| Task | Goal Contract | Depends On | Execution Mode | Integration |\n|---|---|---|---|---|\n",
    )
    const result = runVerifier({ ...fixture, cliArgs: [] })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(fs.existsSync(path.join(fixture.root, "package.json")), false)
    assert.equal(report.evidence.selfTest.status, "passed")
    assert.equal(report.coverage.complete, true)
    assert.equal(
        report.findings.some((finding) => finding.rule === "self-test-passed"),
        false,
    )
    assert.equal(report.verdict, "incomplete")
})

test("JSON mode reports handled invocation errors as tooling evidence", (t) => {
    const fixture = createFixture(t, exact)
    let result = runVerifier({ ...fixture, cliArgs: ["--scope", "unknown"] })
    assert.equal(result.status, 2, result.stderr || result.stdout)
    let report = JSON.parse(result.stdout)
    assert.equal(report.verdict, "tooling_error")
    assert.equal(report.counts.tooling, 1)
    assert.equal(report.coverage.complete, false)

    result = spawnSync(process.execPath, [verifierPath, "--workstream", path.join(fixture.root, "missing"), "--json"], {
        cwd: fixture.root,
        encoding: "utf8",
    })
    assert.equal(result.status, 2, result.stderr || result.stdout)
    report = JSON.parse(result.stdout)
    assert.equal(report.verdict, "tooling_error")
    assert.equal(report.counts.tooling, 1)

    const crashFixture = createFixture(t, exact)
    const specPath = path.join(crashFixture.target, "spec.md")
    fs.rmSync(specPath)
    fs.mkdirSync(specPath)
    result = runVerifier(crashFixture)
    assert.equal(result.status, 2, result.stderr || result.stdout)
    report = JSON.parse(result.stdout)
    assert.equal(report.verdict, "tooling_error")
    assert.equal(report.evidence.selfTest.status, "failed")
    assert.match(report.findings[0].message, /crashed/i)
})

test("aggregate invocation never probes root status, execution graph or sibling workstreams", (t) => {
    const fixture = createFixture(
        t,
        "# WS-TEST Target\n\nArchitecture-Mode: diagram-driven-v1\n\nArrow labels are normative: `owns`.\n",
    )
    fs.writeFileSync(
        path.join(fixture.target, "plan.md"),
        "# WS-TEST Plan\n\n| Task | Goal Contract | Depends On | Execution Mode | Integration |\n|---|---|---|---|---|\n",
    )
    const sibling = path.join(fixture.workstreamsDir, "WS-OTHER-poison")
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(sibling, "spec.md"), "poison")
    const rootStatus = path.join(fixture.root, ".memory-bank", "status.yml")
    const execution = path.join(fixture.root, ".memory-bank", "execution.md")
    fs.writeFileSync(rootStatus, "poison")
    fs.writeFileSync(execution, "poison")

    const preload = path.join(fixture.root, "forbid-fs-access.mjs")
    fs.writeFileSync(
        preload,
        [
            'import fs from "node:fs"',
            'import path from "node:path"',
            'import { fileURLToPath } from "node:url"',
            'const forbidden = JSON.parse(process.env.DLINE_TEST_FORBIDDEN_PATHS ?? "[]").map((entry) => path.resolve(entry))',
            "const reject = (value) => {",
            '    if (typeof value === "number") return',
            "    const candidate = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value))",
            "    if (forbidden.some((entry) => candidate === entry || candidate.startsWith(`${entry}${path.sep}`))) {",
            "        throw new Error(`forbidden filesystem access: ${candidate}`)",
            "    }",
            "}",
            'for (const method of ["existsSync", "readFileSync", "readdirSync", "statSync", "lstatSync", "openSync"]) {',
            "    const original = fs[method]",
            "    fs[method] = function guarded(value, ...args) { reject(value); return original.call(this, value, ...args) }",
            "}",
            "",
        ].join("\n"),
    )

    const result = runVerifier({
        ...fixture,
        preload,
        forbidden: [rootStatus, execution, sibling],
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(report.exitCode, 0)
    assert.equal(report.counts.tooling, 0)
    assert.equal(report.counts.blocking, 0)
})
