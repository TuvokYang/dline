import assert from "node:assert/strict"
import test from "node:test"
import { checkTaskAgainstWorkstream } from "../lib/checks-b2.mjs"
import { checkInterLevel, checkRefinementCoverage } from "../lib/checks-interlevel.mjs"
import { checkIntraLayer } from "../lib/checks-intra.mjs"
import { parseFlowchart } from "../lib/mermaid-parse.mjs"
import { computeExitCode, computeVerdict } from "../lib/report.mjs"

function diagram(id, layer, body, kind = "structure") {
    const parsed = parseFlowchart(
        ["flowchart LR", `%% id: ${id}`, `%% layer: ${layer}`, `%% kind: ${kind}`, ...body.split("\n")],
        { file: `${id}.md`, firstLine: 1 },
    )
    assert.deepEqual(parsed.problems, [])
    return parsed.diagram
}

test("a descriptive label has a checked category only with an exact normative verb prefix", () => {
    const vocabulary = new Set(["injects"])
    assert.deepEqual(
        checkIntraLayer(diagram("good", "L0", "A[A] -->|injects immutable configuration facts| B[B]"), vocabulary),
        [],
    )
    for (const label of ["notinjects a value", "injectsUnknown", "hands a value"]) {
        assert.equal(
            checkIntraLayer(diagram("bad", "L0", `A[A] -->|${label}| B[B]`), vocabulary).some(
                (finding) => finding.severity === "blocking",
            ),
            true,
        )
    }
})

test("an explicitly declared flow is checked for labels and fact semantics rather than ownership vocabulary", () => {
    assert.deepEqual(checkIntraLayer(diagram("flow", "L2", "A[A] -->|prepare round| B[B]", "flow"), new Set(["injects"])), [])
    assert.equal(
        checkIntraLayer(diagram("bad-flow", "L2", "A[A] --> B[B]", "flow"), new Set(["injects"])).some(
            (finding) => finding.rule === "unlabelled-solid-edge",
        ),
        true,
    )
    assert.equal(
        checkIntraLayer(diagram("bad-fact", "L2", "A[A] -.->|submit work| B[B]", "flow"), new Set(["injects"])).some(
            (finding) => finding.rule === "dotted-edge-carries-command",
        ),
        true,
    )
})

test("reverse direction and a fact label do not invent a missing coarse fact contract", () => {
    const coarse = diagram("coarse", "L0", "A[A] -->|submits| B[B]\nB -->|writes| C[C]")
    const fine = diagram("fine", "L1", "A[A] -->|submits| B[B]\nB -->|writes| C[C]\nB -.->|accepted result fact| A")
    assert.equal(
        checkInterLevel(coarse, fine, { declared: true }).some((finding) => finding.rule === "extra-dotted-edge"),
        true,
    )
    coarse.edges.push({ from: "B", to: "A", style: "dotted", label: "accepted result fact", line: 8 })
    assert.deepEqual(checkInterLevel(coarse, fine, { declared: true }), [])
    fine.edges.push({ from: "A", to: "C", style: "dotted", label: "result fact", line: 8 })
    assert.equal(
        checkInterLevel(coarse, fine, { declared: true }).some((finding) => finding.rule === "extra-dotted-edge"),
        true,
    )
})

test("coarse node coverage is the union of declared descendant refinements, never guessed siblings", () => {
    const coarse = diagram("parent", "L0", "A[A] -->|submits| B[B]\nB -->|writes| C[C]")
    const first = diagram("first", "L1", "A[A] -->|submits| B[B]")
    const second = diagram("second", "L2", "B[B] -->|writes| C[C]")
    const pairs = [
        { coarse, fine: first, declared: true },
        { coarse, fine: second, declared: true },
    ]
    assert.deepEqual(checkRefinementCoverage([coarse, first, second], pairs), [])
    const omitted = checkRefinementCoverage([coarse, first], [{ coarse, fine: first, declared: true }])
    assert.equal(
        omitted.some((finding) => finding.rule === "coarse-node-not-refined"),
        true,
    )
    assert.equal(
        checkRefinementCoverage(
            [coarse, first, second],
            pairs.map((pair) => ({ ...pair, declared: false })),
        ).some((finding) => finding.rule === "coarse-node-not-refined"),
        true,
    )
})

test("set coverage does not also require every selective pair to cover the same edge", () => {
    const coarse = diagram("parent", "L0", "A[A] -->|injects| B[B]")
    const selective = diagram(
        "selective",
        "L1",
        "%% local-only: X\n%% local-only: Y\nA[A] -->|injects| X[X]\nB[B] -->|injects| Y[Y]",
    )
    const connected = diagram("connected", "L1", "A[A] -->|injects| B[B]")
    const pairs = [selective, connected].map((fine) => ({ coarse, fine, declared: true }))
    assert.equal(
        checkInterLevel(coarse, selective, { declared: true }).some((finding) => finding.rule === "coarse-edge-not-refined"),
        true,
    )
    assert.deepEqual(checkInterLevel(coarse, selective, { declared: true, coverageCheckedAtSet: true }), [])
    assert.deepEqual(checkRefinementCoverage([coarse, selective, connected], pairs), [])
    assert.equal(
        checkRefinementCoverage([coarse, selective], pairs.slice(0, 1)).some(
            (finding) => finding.rule === "coarse-edge-not-refined",
        ),
        true,
    )
})

test("a task edge may be declared by one parent without being duplicated in every parent", () => {
    const primary = diagram("primary", "L1", "A[A] -->|injects| B[B]")
    const selective = diagram("selective", "L1", "A[A] -->|injects| C[C]\nB[B]")
    const task = diagram("task", "L2", "%% refines: primary, selective\nA[A] -->|injects| B[B]")
    const check = (parents) =>
        checkTaskAgainstWorkstream({
            taskId: "TASK-001",
            taskDiagram: task,
            wsDiagrams: parents,
            labelVocabulary: new Set(["injects"]),
            specText: "",
        })
    assert.deepEqual(check([primary, selective]), [])
    selective.edges.push({ from: "B", to: "A", style: "solid", label: "injects", line: 8 })
    assert.equal(
        check([primary, selective]).some((finding) => finding.rule === "task-edge-inverted"),
        true,
    )
    task.refines = ["missing"]
    assert.equal(
        check([primary]).some((finding) => finding.rule === "task-refines-unknown"),
        true,
    )
})

test("separately covered endpoints cannot discharge the missing coarse relationship", () => {
    const coarse = diagram("parent", "L0", "A[A] -->|injects| B[B]")
    const first = diagram("first", "L1", "%% local-only: X\nA[A] -->|injects| X[X]")
    const second = diagram("second", "L1", "%% local-only: Y\nY[Y] -->|injects| B[B]")
    const pairs = [
        { coarse, fine: first, declared: true },
        { coarse, fine: second, declared: true },
    ]
    const missing = checkRefinementCoverage([coarse, first, second], pairs)
    assert.equal(
        missing.some((finding) => finding.rule === "coarse-edge-not-refined" && finding.severity === "warning"),
        true,
    )
    const connected = diagram("connected", "L1", "%% local-only: X\nA[A] -->|injects| X[X]\nX -->|injects| B[B]")
    assert.deepEqual(checkRefinementCoverage([coarse, connected], [{ coarse, fine: connected, declared: true }]), [])
})

test("unrefined boxes warn without proving coverage or hiding contradictory refinements", () => {
    const coarse = diagram("parent", "L0", "A[A] -->|injects| B[B]")
    const fine = diagram("selective", "L1", "%% local-only: X\nA[A] -->|injects| X[X]")
    const pending = checkRefinementCoverage([coarse, fine], [{ coarse, fine, declared: true }])
    assert.deepEqual(
        pending.map(({ rule, severity }) => ({ rule, severity })),
        [
            { rule: "coarse-node-not-refined", severity: "warning" },
            { rule: "coarse-edge-not-refined", severity: "warning" },
        ],
    )
    assert.equal(computeExitCode(pending), 0)
    assert.equal(computeVerdict(pending), "incomplete")
    const pair = checkInterLevel(coarse, fine, { declared: true })
    assert.equal(pair.find((item) => item.rule === "coarse-node-not-refined")?.severity, "warning")
    const disconnected = diagram(
        "disconnected",
        "L1",
        "%% local-only: X\n%% local-only: Y\nA[A] -->|injects| X[X]\nB[B] -->|injects| Y[Y]",
    )
    assert.equal(
        checkInterLevel(coarse, disconnected, { declared: true }).find((item) => item.rule === "coarse-edge-not-refined")
            ?.severity,
        "warning",
    )
    for (const [body, rule] of [
        ["B[B] -->|injects| A[A]", "edge-direction-inverted"],
        ["A[A] -.->|result fact| B[B]", "edge-style-downgraded"],
        ["A[A] -->|injects| C[C]", "node-unresolved"],
    ]) {
        const conflict = checkInterLevel(coarse, diagram("conflict", "L1", body), { declared: true })
        assert.equal(
            conflict.some((item) => item.rule === rule),
            true,
            rule,
        )
        assert.equal(computeExitCode([...pending, ...conflict]), 1, rule)
    }
})

test("a fact noun cannot mask an explicit dotted command", () => {
    for (const label of [
        "submit result",
        "call committed state",
        "delete published evidence",
        "persist readiness",
        "commit result fact",
        "open file result fact",
        "result fact; then delete records",
        "result fact and delete records",
        "no new work and delete records",
        "never submit work; then delete records",
        "must not persist facts and delete records",
        "result fact; Runtime must commit records",
        "Runtime shall publish readiness",
        "Runtime must release facts",
        "Runtime should open matching receipt",
    ]) {
        const findings = checkIntraLayer(
            diagram("command", "L0", `A[A] -->|injects| B[B]\nB -.->|${label}| A`),
            new Set(["injects"]),
        )
        assert.equal(
            findings.some((finding) => finding.rule === "dotted-edge-carries-command"),
            true,
            label,
        )
    }
    for (const label of [
        "dispatch held",
        "release facts",
        "accepted result fact",
        "open enrollment receipt or closed rejection fact",
        "prepare failed settled or maintenance-not-required fact",
        "close release unavailable or foreign-lock facts",
        "canonical commit and revision facts",
        "original sealed delete handle or typed pending fact; never an owner handle",
        "aggregate health fact; never ordinary submit",
        "open matching receipt or closed/rejected fact",
        "non-authorizing maintenance observation facts; Runtime commits before projection",
        "decision proposal fact; durable only after Runtime commit",
        "committed child create open close result acknowledgement reclaim or orphan-cleanup intent fact",
        "correlated main closed fact after endpoint unpublish and child drain",
        "sealed quiesced resumed closed completed recovery-needed and boundary facts as events; writes held until resume or publish",
        "while open: durable enrollment receipt; while closed: typed rejection",
        "main closed only after its child stop closed and handle-release receipts settle",
        "all sealed delete handles and coordination receipts released; no child ownership",
        "view query and read-handle release or still-pending facts",
        "Runtime must not commit records",
        "Runtime shall never publish records",
    ]) {
        assert.deepEqual(
            checkIntraLayer(diagram("fact", "L0", `A[A] -->|injects| B[B]\nB -.->|${label}| A`), new Set(["injects"])),
            [],
        )
    }
})

test("unclassified dotted prose remains unverifiable rather than being treated as a fact", () => {
    for (const label of ["Runtime commits records", "an arbitrary description"]) {
        assert.equal(
            checkIntraLayer(diagram("unknown", "L0", `A[A] -->|injects| B[B]\nB -.->|${label}| A`), new Set(["injects"])).some(
                (finding) => finding.rule === "dotted-edge-semantics-unknown",
            ),
            true,
            label,
        )
    }
})

test("L0 cannot silently authorize an invented L1 lifetime", () => {
    const coarse = diagram("parent", "L0", "A[A] -->|injects| B[B]")
    const fine = diagram("child", "L1", "subgraph invented [Invented Lifetime]\nA[A] -->|injects| B[B]\nend")
    assert.equal(
        checkInterLevel(coarse, fine, { declared: true }).some(
            (finding) => finding.rule === "new-lifetime-scope" && finding.severity === "unverifiable",
        ),
        true,
    )
})
