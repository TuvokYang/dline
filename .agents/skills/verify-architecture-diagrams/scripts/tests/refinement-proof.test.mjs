import assert from "node:assert/strict"
import test from "node:test"
import { checkInterLevel, checkRefinementCoverage } from "../lib/checks-interlevel.mjs"
import { checkIntraLayer } from "../lib/checks-intra.mjs"
import { parseFlowchart } from "../lib/mermaid-parse.mjs"

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
        missing.some((finding) => finding.rule === "coarse-edge-not-refined" && finding.severity === "unverifiable"),
        true,
    )
    const connected = diagram("connected", "L1", "%% local-only: X\nA[A] -->|injects| X[X]\nX -->|injects| B[B]")
    assert.deepEqual(checkRefinementCoverage([coarse, connected], [{ coarse, fine: connected, declared: true }]), [])
})

test("a fact noun cannot mask an explicit dotted command", () => {
    for (const label of ["submit result", "call committed state", "delete published evidence", "persist readiness"]) {
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
    for (const label of ["dispatch held", "release facts", "accepted result fact"]) {
        assert.deepEqual(
            checkIntraLayer(diagram("fact", "L0", `A[A] -->|injects| B[B]\nB -.->|${label}| A`), new Set(["injects"])),
            [],
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
