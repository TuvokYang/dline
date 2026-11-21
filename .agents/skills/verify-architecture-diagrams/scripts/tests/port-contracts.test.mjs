import assert from "node:assert/strict"
import test from "node:test"

import { createDiagram, parseFlowchart } from "../lib/mermaid-parse.mjs"
import { checkPortContracts, parsePortAnnotation } from "../lib/port-contracts.mjs"

function diagram(body, options = {}) {
    const parsed = parseFlowchart(["flowchart LR", ...body.trim().split(/\r?\n/)], { file: "ports.md", firstLine: 1, ...options })
    assert.deepEqual(parsed.problems, [])
    return parsed.diagram
}

function blocking(findings) {
    return findings.filter((entry) => ["blocking", "unverifiable", "tooling"].includes(entry.severity))
}

function rules(model) {
    return checkPortContracts(model).map((entry) => entry.rule)
}

function pairSource({
    completeness = "complete",
    fromMode = "out",
    toMode = "in",
    fromType = "Message@v1",
    toType = fromType,
    required = "true",
    style = "solid",
    label = "accepted result fact",
    bind = true,
    extra = "",
} = {}) {
    return `
%% ports: A completeness=${completeness}
%% ports: B completeness=${completeness}
%% port: A.send mode=${fromMode} type=${fromType} required=${required}
%% port: B.accept mode=${toMode} type=${toType} required=${required}
${bind ? `%% edge-ports: from=A to=B style=${style} label="${label}" from_port=send to_port=accept` : ""}
A[Producer] ${style === "solid" ? "-->" : "-.->"}|${label}| B[Consumer]
${extra}
`
}

function pair(options) {
    return diagram(pairSource(options))
}

test("legacy diagrams are compatible and explicitly not checked for port contracts", () => {
    const model = diagram("%% kind: structure\nA[A] -->|hands| B[B]")
    assert.equal(model.portContracts.enabled, false)
    assert.equal(model.edges.length, 1)
    assert.deepEqual(
        checkPortContracts(model).map(({ rule, severity }) => ({ rule, severity })),
        [{ rule: "port-contracts-not-enabled", severity: "not-checked" }],
    )
    const legacy = { ...model }
    delete legacy.portContracts
    assert.deepEqual(checkPortContracts(legacy), checkPortContracts(model))
})

test("annotation API consumes only port annotations, including malformed ones", () => {
    const model = createDiagram("api.md", 4)
    assert.equal(parsePortAnnotation(model, "note: this is not a port", 5), false)
    assert.equal(parsePortAnnotation(model, "portfolio: unrelated", 6), false)
    assert.equal(model.portContracts.enabled, false)
    assert.equal(parsePortAnnotation(model, "port A.send mode=out type=Message required=true", 7), true)
    assert.ok(rules(model).includes("port-annotation-syntax"))
    assert.equal(model.nodes.size, 0)
    assert.equal(model.edges.length, 0)
})

test("complete inventories resolve preceding annotations to the one existing quoted-label edge", () => {
    const model = pair()
    assert.deepEqual(blocking(checkPortContracts(model)), [])
    assert.equal(model.edges.length, 1)
    assert.deepEqual(Object.keys(model.edges[0]).sort(), ["from", "label", "line", "style", "to"])
    assert.equal(model.portContracts.ports.get("A").get("send").required, true)
    assert.equal(model.portContracts.edgeAnnotations[0].selector.label, "accepted result fact")
    assert.deepEqual(rules(model), ["port-runtime-not-checked"])
})

test("annotation order is independent of edge and node order", () => {
    const source = pairSource().trim().split("\n")
    const edge = source.pop()
    const model = diagram([edge, ...source].join("\n"))
    assert.deepEqual(blocking(checkPortContracts(model)), [])
    assert.equal(model.edges.length, 1)
})

test("out -> in accepts solid and dotted data edges, requires -> provides accepts solid only", () => {
    for (const style of ["solid", "dotted"]) {
        assert.deepEqual(blocking(checkPortContracts(pair({ style }))), [], style)
    }
    assert.deepEqual(blocking(checkPortContracts(pair({ fromMode: "requires", toMode: "provides" }))), [])
    const invalid = pair({ fromMode: "requires", toMode: "provides", style: "dotted" })
    assert.ok(rules(invalid).includes("port-requires-solid"))
    assert.ok(rules(invalid).includes("port-required-unconnected"))
})

test("equal nominal types do not excuse reversed or mixed port directions", () => {
    for (const [fromMode, toMode] of [
        ["in", "out"],
        ["provides", "requires"],
        ["out", "provides"],
        ["requires", "in"],
        ["out", "out"],
        ["in", "in"],
    ]) {
        const result = rules(pair({ fromMode, toMode }))
        assert.ok(result.includes("port-direction-incompatible"), `${fromMode} -> ${toMode}`)
        assert.ok(result.includes("port-required-unconnected"))
    }
})

test("nominal type identity preserves case, versions, namespace spelling and Unicode spelling", () => {
    for (const [fromType, toType] of [
        ["Message@v1", "message@v1"],
        ["Message@v1", "Message@v2"],
        ["pkg/Message:V1", "pkg/Message:v1"],
        ["Café@v1", "Cafe\u0301@v1"],
    ]) {
        assert.ok(rules(pair({ fromType, toType })).includes("port-type-mismatch"), `${fromType} != ${toType}`)
    }
    assert.deepEqual(blocking(checkPortContracts(pair({ fromType: "contracts/Message:V1#Result" }))), [])
})

test("empty, unknown, any and type expressions are never nominal type evidence", () => {
    for (const type of ["", " ", "unknown", "UNKNOWN", "any", "Any", "Pair<T>", "A|B", "A & B", "{}", "Item[]"]) {
        const model = diagram(`%% port: A.send mode=out type=${JSON.stringify(type)} required=false\nA[A]`)
        const invalid = checkPortContracts(model).find((entry) => entry.rule === "port-type-unverifiable")
        assert.equal(invalid?.severity, "unverifiable", type)
        assert.equal(invalid?.stage, "0", type)
        assert.equal(model.portContracts.ports.size, 0, type)
    }
})

test("complete inventories enforce required ports in all four modes but allow disconnected optional ports", () => {
    for (const mode of ["in", "out", "requires", "provides"]) {
        for (const required of ["true", "false"]) {
            const model = diagram(`
%% ports: A completeness=complete
%% port: A.endpoint mode=${mode} type=Contract.V1 required=${required}
A[A]
`)
            assert.equal(rules(model).includes("port-required-unconnected"), required === "true", `${mode} ${required}`)
            assert.equal(blocking(checkPortContracts(model)).length, required === "true" ? 1 : 0)
        }
    }
    assert.deepEqual(blocking(checkPortContracts(diagram("%% ports: A completeness=complete\nA[A]"))), [])
})

test("partial inventories validate declarations, not missing required connections or unbound incident edges", () => {
    const model = diagram(`
%% ports: A completeness=partial
%% port: A.accept mode=in type=Message required=true
A[A] -->|hands| B[B]
`)
    assert.deepEqual(blocking(checkPortContracts(model)), [])
    assert.ok(rules(model).includes("port-inventory-partial"))
    assert.ok(!rules(model).includes("port-required-unconnected"))
    assert.ok(!rules(model).includes("port-incident-edge-unbound"))
    const mismatch = pair({ completeness: "partial", toType: "Different" })
    assert.ok(rules(mismatch).includes("port-type-mismatch"))
    assert.ok(!rules(mismatch).includes("port-required-unconnected"))
})

test("port declarations without inventories are implicitly partial, not silently complete", () => {
    const model = diagram("%% port: A.send mode=out type=Message required=true\nA[A]")
    assert.deepEqual(blocking(checkPortContracts(model)), [])
    assert.ok(rules(model).includes("port-inventory-partial"))
    assert.equal(model.portContracts.inventories.size, 0)
})

test("complete inventories require every incident endpoint to bind even when ports are optional", () => {
    const model = pair({ required: "false", bind: false })
    assert.equal(rules(model).filter((rule) => rule === "port-incident-edge-unbound").length, 2)
    assert.ok(!rules(model).includes("port-required-unconnected"))
})

test("mixed completeness only imposes edge coverage on the complete black box", () => {
    const source = pairSource().replace("B completeness=complete", "B completeness=partial")
    const model = diagram(`${source}\nB -->|hands| C[C]`)
    assert.deepEqual(blocking(checkPortContracts(model)), [])
    const partial = checkPortContracts(model).find((entry) => entry.rule === "port-inventory-partial")
    assert.match(partial.message, /B, C/)
})

test("every bound endpoint must name a declared port, including in partial mode", () => {
    const source = pairSource({ completeness: "partial" }).replace("to_port=accept", "to_port=missing")
    assert.ok(rules(diagram(source)).includes("edge-port-unknown"))
    const complete = diagram(pairSource().replace("to_port=accept", "to_port=missing"))
    assert.ok(rules(complete).includes("port-required-unconnected"))
    assert.ok(rules(complete).includes("port-incident-edge-unbound"))
})

test("self edges bind both endpoints independently without bypassing direction checking", () => {
    const model = diagram(`
%% ports: A completeness=complete
%% port: A.send mode=out type=Message required=true
%% port: A.accept mode=in type=Message required=true
%% edge-ports: from=A to=A style=solid label=hands from_port=send to_port=accept
A[A] -->|hands| A
`)
    assert.deepEqual(blocking(checkPortContracts(model)), [])
    assert.equal(model.edges.length, 1) // Cycle checks remain the caller's responsibility.
})

test("edge selectors match from, to, style and label exactly, never create edges", () => {
    for (const [search, replacement] of [
        ["from=A to=B", "from=B to=A"],
        ["style=solid label=", "style=dotted label="],
        ['label="accepted result fact"', 'label="Accepted result fact"'],
        ['label="accepted result fact"', 'label="accepted  result fact"'],
        ['label="accepted result fact"', 'label="missing"'],
    ]) {
        const model = diagram(pairSource().replace(search, replacement))
        const before = structuredClone(model.edges)
        assert.ok(rules(model).includes("edge-ports-unmatched"), replacement)
        assert.deepEqual(model.edges, before)
        assert.equal(model.edges.length, 1)
    }
})

test("empty labels remain distinct from absent labels during exact edge selection", () => {
    assert.deepEqual(blocking(checkPortContracts(pair({ label: "" }))), [])
    const absent = diagram(pairSource({ label: "" }).replace("-->||", "-->"))
    assert.equal(absent.edges[0].label, null)
    assert.ok(rules(absent).includes("edge-ports-unmatched"))
})

test("an annotation alone cannot supply a missing graph relationship", () => {
    const model = diagram(`
%% port: A.send mode=out type=Message required=true
%% port: B.accept mode=in type=Message required=true
%% edge-ports: from=A to=B style=solid label=hands from_port=send to_port=accept
A[A]
B[B]
`)
    assert.ok(rules(model).includes("edge-ports-unmatched"))
    assert.equal(model.edges.length, 0)
})

test("multiple exact edge matches are rejected instead of selecting the first edge", () => {
    const model = pair({ extra: "A -->|accepted result fact| B" })
    assert.ok(rules(model).includes("edge-ports-ambiguous"))
    assert.ok(rules(model).includes("port-required-unconnected"))
    assert.equal(model.edges.length, 2)
})

test("parallel edges with distinct labels/styles are not ambiguous", () => {
    const model = pair({
        extra: `
%% edge-ports: from=A to=B style=dotted label="accepted result fact" from_port=send to_port=accept
%% edge-ports: from=A to=B style=solid label=other from_port=send to_port=accept
A -.->|accepted result fact| B
A -->|other| B`,
    })
    assert.deepEqual(blocking(checkPortContracts(model)), [])
    assert.equal(model.edges.length, 3)
})

test("duplicate edge decorations are rejected and cannot discharge required connections", () => {
    const model = pair({
        extra: '%% edge-ports: from=A to=B style=solid label="accepted result fact" from_port=send to_port=accept',
    })
    assert.ok(rules(model).includes("edge-ports-duplicate"))
    assert.ok(rules(model).includes("port-required-unconnected"))
    assert.equal(model.edges.length, 1)
})

test("duplicate inventories and ports report errors without overwriting the first declaration", () => {
    const model = pair({
        extra: `
%% ports: A completeness=partial
%% port: A.send mode=requires type=Replacement required=false`,
    })
    assert.ok(rules(model).includes("ports-duplicate"))
    assert.ok(rules(model).includes("port-duplicate"))
    assert.equal(model.portContracts.inventories.get("A").completeness, "complete")
    assert.equal(model.portContracts.ports.get("A").get("send").type, "Message@v1")
})

const badAnnotations = [
    ["ports: A completeness=COMPLETE", "ports-completeness-invalid"],
    ["ports: A completeness=complete completeness=partial", "port-attribute-duplicate"],
    ["ports: A completeness=complete scope=all", "port-attribute-unknown"],
    ["ports: A", "port-attribute-missing"],
    ["ports: A$ completeness=complete", "port-target-invalid"],
    ["port: A.send mode=OUT type=Message required=false", "port-mode-invalid"],
    ["port: A.send mode=out type=Message required=TRUE", "port-required-invalid"],
    ["port: A.send mode=out type=Message", "port-attribute-missing"],
    ["port: A.send mode=out type=Message required=false readonly=true", "port-attribute-unknown"],
    ["port: A.send mode=out type=Message type=Other required=false", "port-attribute-duplicate"],
    ["port: A.send mode=out type=Message required=false __proto__=x", "port-attribute-unknown"],
    ["port: A mode=out type=Message required=false", "port-target-invalid"],
    ["port: A. mode=out type=Message required=false", "port-target-invalid"],
    ["port: .send mode=out type=Message required=false", "port-target-invalid"],
    ["port: A.send mode=out type=Message required=false garbage", "port-annotation-syntax"],
    ["edge-ports: from=A to=B style=dashed label=hands from_port=send to_port=accept", "edge-ports-style-invalid"],
    ["edge-ports: from=A to=B style=solid label=hands from_port=A.send to_port=accept", "port-target-invalid"],
    ["edge-ports: from=A to=B style=solid label=hands from_port=send to_port=accept extra=true", "port-attribute-unknown"],
    ["edge-ports: from=A from=B to=B style=solid label=hands from_port=send to_port=accept", "port-attribute-duplicate"],
    ["edge-ports: from=A to=B style=solid from_port=send to_port=accept", "port-attribute-missing"],
    ['edge-ports: from=A to=B style=solid label="hands from_port=send to_port=accept', "port-annotation-syntax"],
    ['edge-ports: from=A to=B style=solid label="hands"from_port=send to_port=accept', "port-annotation-syntax"],
    ["edge-ports: from=A to=B style=solid label=hands from_port=send to_port=accept,", "port-target-invalid"],
]

for (const [annotation, expected] of badAnnotations) {
    test(`real parser rejects invalid port annotation: ${annotation}`, () => {
        const model = diagram(`%% ${annotation}\nA[A] -->|hands| B[B]`)
        const errors = checkPortContracts(model).filter((entry) => entry.stage === "0")
        assert.ok(
            errors.some((entry) => entry.rule === expected),
            expected,
        )
        assert.ok(errors.every((entry) => entry.severity === "blocking"))
        assert.equal(model.portContracts.inventories.size, 0)
        assert.equal(model.portContracts.ports.size, 0)
        assert.equal(model.portContracts.edgeAnnotations.length, 0)
        assert.equal(model.edges.length, 1)
    })
}

test("unknown annotation targets do not register phantom graph nodes", () => {
    const model = diagram(`
%% ports: Missing completeness=complete
%% port: Ghost.send mode=out type=Message required=false
%% edge-ports: from=Missing to=B style=solid label=hands from_port=send to_port=accept
A[A] -->|hands| B[B]
`)
    assert.ok(rules(model).includes("port-node-unknown"))
    assert.ok(rules(model).includes("edge-ports-unmatched"))
    assert.deepEqual([...model.nodes.keys()], ["A", "B"])
})

test("note nodes and subgraph ids are invalid black-box contract targets", () => {
    const note = diagram(
        "%% note-node: A\n%% ports: A completeness=complete\n%% port: A.send mode=out type=Message required=false\nA[A]",
    )
    assert.ok(rules(note).includes("port-target-invalid"))
    const group = diagram("%% ports: Group completeness=complete\nsubgraph Group[Worker lifetime]\nA[A]\nend")
    assert.ok(rules(group).includes("port-node-unknown"))
})

test("dotted node ids split at the last dot and port references remain exact node ids", () => {
    const model = diagram(`
%% ports: A.part completeness=complete
%% ports: B completeness=complete
%% port: A.part.send_1 mode=out type=pkg.Message/V1 required=true
%% port: B.accept-1 mode=in type=pkg.Message/V1 required=true
%% edge-ports: from=A.part to=B style=solid label=hands from_port=send_1 to_port=accept-1
A.part[Producer] -->|hands| B[Consumer]
`)
    assert.deepEqual(blocking(checkPortContracts(model)), [])
    assert.ok(model.portContracts.ports.get("A.part").has("send_1"))
    const labelNotId = diagram("%% ports: Producer completeness=complete\nA[Producer]")
    assert.ok(rules(labelNotId).includes("port-node-unknown"))
})

test("annotation findings are returned without Stage 7 and use final diagram identity and original source line", () => {
    const model = diagram("%% port: A.send mode=invalid type=Message required=false\n%% id: ports-view\nA[A]", {
        file: "spec.md",
        firstLine: 40,
    })
    const invalid = checkPortContracts(model).find((entry) => entry.rule === "port-mode-invalid")
    assert.deepEqual(
        {
            file: invalid.file,
            line: invalid.line,
            stage: invalid.stage,
            diagram: invalid.diagram,
            attribution: invalid.attribution,
        },
        {
            file: "spec.md",
            line: 41,
            stage: "0",
            diagram: "ports-view",
            attribution: "diagram",
        },
    )
    assert.deepEqual(model.annotationFindings, []) // No dependence on the evidence/Stage 7 collector.
})

test("checks are pure, repeatable, and return fresh findings", () => {
    const model = pair({ toType: "Other" })
    const before = structuredClone(model)
    const first = checkPortContracts(model)
    const second = checkPortContracts(model)
    assert.deepEqual(first, second)
    assert.deepEqual(model, before)
    first[0].message = "changed by caller"
    assert.deepEqual(checkPortContracts(model), second)
})

test("decorations are re-resolved against actual edges rather than a cached connection registry", () => {
    const model = pair()
    assert.deepEqual(blocking(checkPortContracts(model)), [])
    model.edges.push({ ...model.edges[0], line: 100 })
    assert.ok(rules(model).includes("edge-ports-ambiguous"))
    const other = createDiagram("other.md", 1)
    assert.equal(other.portContracts.ports.size, 0)
    assert.equal(other.portContracts.edgeAnnotations.length, 0)
})

test("nominal agreement explicitly does not claim actual wiring, execution or code signature proof", () => {
    const result = checkPortContracts(pair())
    assert.deepEqual(blocking(result), [])
    const limitation = result.find((entry) => entry.rule === "port-runtime-not-checked")
    assert.equal(limitation?.severity, "not-checked")
    assert.match(limitation.message, /code signatures, actual wiring and execution were not checked or proven/)
})
