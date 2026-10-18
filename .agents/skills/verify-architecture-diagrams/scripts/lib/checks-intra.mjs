// Stage 2 (A): intra-diagram structure.
// Stage 1 (cycle detection) is also here because it shares the same edge taxonomy.

import { cyclePath, dottedEdges, findCycles, solidEdges, subgraphChain } from "./graph.mjs"
import { graphNodeIds } from "./mermaid-parse.mjs"

// The declared label categories describe ownership and control composition,
// which only the coarse structural layers express. Hot-path, failure and
// delivery diagrams use flow vocabulary and are not held to that sentence.
const VOCABULARY_LAYERS = new Set(["L0", "L1"])

export function effectiveKind(diagram) {
    return diagram.kind === "flow" ? "flow" : "structure"
}

function vocabularyApplies(diagram) {
    if (effectiveKind(diagram) !== "structure") return false
    return diagram.layer === null || VOCABULARY_LAYERS.has(diagram.layer)
}

const IMPERATIVE = [
    "call",
    "calls",
    "invoke",
    "invokes",
    "construct",
    "constructs",
    "open",
    "opens",
    "submit",
    "submits",
    "commit",
    "commits",
    "publish",
    "publishes",
    "transfer",
    "transfers",
    "prepare",
    "prepares",
    "activate",
    "activates",
    "acquire",
    "acquires",
    "release",
    "releases",
    "bootstrap",
    "bootstraps",
    "dispatch",
    "dispatches",
    "adopt",
    "adopts",
    "seal",
    "seals",
    "close",
    "closes",
    "resume",
    "resumes",
    "drain",
    "drains",
    "attach",
    "attaches",
    "project",
    "projects",
    "inject",
    "injects",
    "authorize",
    "authorizes",
    "persist",
    "persists",
    "dispose",
    "disposes",
    "delete",
    "deletes",
    "remove",
    "removes",
]

const FACT_NOUNS = [
    "fact",
    "facts",
    "readiness",
    "failure",
    "failed",
    "published",
    "rejected",
    "durability",
    "durable",
    "released",
    "release",
    "unavailable",
    "completion",
    "completed",
    "pending",
    "superseded",
    "adopted",
    "held",
    "ready",
    "remaining",
    "quiescence",
    "sealed",
    "committed",
    "aborted",
    "canceled",
    "cancelled",
    "exhausted",
    "available",
    "recovered",
    "converged",
    "result",
    "results",
    "state",
    "status",
    "outcome",
    "diagnostics",
    "evidence",
    "confirmation",
]

const CONSTRAINT_FORMS = [/\bno new\b/i, /\bremains\b/i, /\bmust not\b/i, /\bnever\b/i, /\bwithout\b/i, /\bnot yet\b/i]

function words(label) {
    return label
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
}

// A dotted label is a fact or a constraint unless nothing in it names a fact.
// Noun uses such as "dispatch held" or "release facts" are facts, not commands,
// so facts and constraints are classified before imperatives.
export function classifyDottedLabel(label) {
    if (label === null || label === undefined) return { kind: "missing" }
    const lower = label.toLowerCase()
    const tokens = words(label)
    const fact = tokens.find((token) => FACT_NOUNS.includes(token))
    const constraint = CONSTRAINT_FORMS.some((form) => form.test(lower))

    if (fact) return { kind: "fact", fact }
    if (constraint) return { kind: "constraint" }

    const imperative = tokens.find((token) => IMPERATIVE.includes(token))
    if (imperative) return { kind: "command", imperative }
    return { kind: "unknown" }
}

function finding(severity, stage, diagram, edge, rule, message) {
    return {
        severity,
        attribution: "diagram",
        stage,
        file: diagram.file,
        line: edge?.line ?? diagram.line,
        diagram: diagram.answers ?? diagram.layer ?? diagram.file,
        rule,
        message,
    }
}

// A flow loop is legitimate only when the protocol can leave it: some member
// has a solid edge to a node outside the loop, or a member is terminal.
function flowLoopHasExit(component, solids, nodeIds) {
    const members = new Set(component)
    const known = new Set(nodeIds)
    for (const edge of solids) {
        if (!members.has(edge.from)) continue
        if (!members.has(edge.to) && known.has(edge.to)) return true
    }
    return false
}

// Stage 1: only solid edges form the dependency graph.
// A structure diagram must be acyclic. A flow diagram may loop, but every loop
// needs an exit; a loop with no way out is a protocol that cannot converge.
export function checkCycles(diagram) {
    const findings = []
    const nodeIds = graphNodeIds(diagram)
    const nodeSet = new Set(nodeIds)
    const solids = solidEdges(diagram).filter((edge) => nodeSet.has(edge.from) && nodeSet.has(edge.to))
    const { components, selfLoops } = findCycles(nodeIds, solids)
    const kind = effectiveKind(diagram)

    if (diagram.kind && diagram.kind.startsWith("invalid:")) {
        findings.push(
            finding(
                "blocking",
                "1",
                diagram,
                { line: diagram.line },
                "kind-invalid",
                `%% kind: must be structure or flow, got ${diagram.kind.slice("invalid:".length)}`,
            ),
        )
    }

    for (const loop of selfLoops) {
        if (kind === "flow") continue
        findings.push(
            finding(
                "blocking",
                "1",
                diagram,
                loop,
                "solid-self-loop",
                `solid edge ${loop.from} --> ${loop.from} forms a self dependency`,
            ),
        )
    }

    if (kind === "flow") {
        let accepted = 0
        for (const component of components) {
            const path = cyclePath(component, solids)
            if (flowLoopHasExit(component, solids, nodeIds)) {
                accepted += 1
                continue
            }
            findings.push(
                finding(
                    "blocking",
                    "1",
                    diagram,
                    { line: diagram.line },
                    "flow-loop-without-exit",
                    `flow loop ${path.join(" --> ")} has no solid edge leaving it; the protocol cannot converge`,
                ),
            )
        }
        if (accepted > 0) {
            findings.push(
                finding(
                    "not-checked",
                    "1",
                    diagram,
                    { line: diagram.line },
                    "flow-loops-accepted",
                    `${accepted} loop(s) accepted because %% kind: flow and each loop has an exit`,
                ),
            )
        }
        return findings
    }

    const exemption = diagram.cycleAllowed[0] ?? null
    for (const component of components) {
        const hasSelfLoop = selfLoops.some((edge) => component.includes(edge.from))
        if (component.length === 1 && hasSelfLoop) continue
        const path = cyclePath(component, solids)
        const message = `solid dependency cycle: ${path.join(" --> ")}`
        if (exemption && (!exemption.owner || !exemption.reason)) {
            findings.push(
                finding(
                    "blocking",
                    "1",
                    diagram,
                    { line: diagram.line },
                    "cycle-exemption-incomplete",
                    `${message}; %% cycle: allowed requires owner and reason`,
                ),
            )
            continue
        }
        if (exemption) {
            findings.push({
                ...finding(
                    "not-checked",
                    "1",
                    diagram,
                    { line: diagram.line },
                    "cycle-exempted",
                    `${message}; exempted by owner=${exemption.owner} reason=${exemption.reason}`,
                ),
            })
            continue
        }
        findings.push(finding("blocking", "1", diagram, { line: diagram.line }, "solid-cycle", message))
    }

    return findings
}

// Stage 2: node and subgraph structure inside one diagram.
export function checkIntraLayer(diagram, labelVocabulary) {
    const findings = []

    for (const subgraph of diagram.subgraphs) {
        if (subgraph.parent && !diagram.subgraphs.some((candidate) => candidate.id === subgraph.parent)) {
            findings.push(
                finding(
                    "blocking",
                    "2",
                    diagram,
                    { line: subgraph.line },
                    "subgraph-parent-unknown",
                    `subgraph ${subgraph.id} names an unknown parent ${subgraph.parent}`,
                ),
            )
        }
        if (!subgraph.label || subgraph.label === subgraph.id) {
            findings.push(
                finding(
                    "blocking",
                    "2",
                    diagram,
                    { line: subgraph.line },
                    "subgraph-unlabelled",
                    `subgraph ${subgraph.id} has no lifetime label`,
                ),
            )
        }
    }

    const connected = new Set()
    for (const edge of diagram.edges) {
        connected.add(edge.from)
        connected.add(edge.to)
    }
    // A note node renders a constraint the reader must see; it asserts no relation by design.
    const isolated = [...diagram.nodes.values()].filter((node) => !connected.has(node.id) && !diagram.noteNodes.has(node.id))
    for (const noteId of diagram.noteNodes) {
        if (!diagram.nodes.has(noteId)) {
            findings.push(
                finding(
                    "blocking",
                    "2",
                    diagram,
                    { line: diagram.line },
                    "note-node-unknown",
                    `%% note-node: ${noteId} names a node the diagram does not draw`,
                ),
            )
        }
    }
    if (isolated.length > 0) {
        const names = isolated
            .slice(0, 6)
            .map((node) => `${node.id}@${node.line}`)
            .join(", ")
        findings.push(
            finding(
                "blocking",
                "2",
                diagram,
                { line: isolated[0].line },
                "isolated-node",
                `${isolated.length} node(s) have no edge and assert no relation: ${names}${isolated.length > 6 ? ", ..." : ""}`,
            ),
        )
    }

    // The normative sentence names meaning categories, not an exhaustive label
    // list, so descriptive labels are allowed. A diagram that uses none of the
    // declared categories has drifted from the contract as a whole; that is one
    // finding per diagram, not one per edge.
    const declaredHits = []
    const descriptive = []
    const unlabelled = []
    for (const edge of diagram.edges) {
        if (edge.style !== "solid") continue
        if (!edge.label) {
            unlabelled.push(edge)
            continue
        }
        const normalized = edge.label.replace(/\s+/g, " ")
        if (labelVocabulary && (labelVocabulary.has(edge.label) || labelVocabulary.has(normalized))) declaredHits.push(normalized)
        else descriptive.push({ edge, label: normalized })
    }

    // One finding per diagram: the defect is the habit, not the individual edge.
    if (unlabelled.length > 0) {
        const sample = unlabelled
            .slice(0, 5)
            .map((edge) => `${edge.from}-->${edge.to}@${edge.line}`)
            .join(", ")
        findings.push(
            finding(
                "blocking",
                "2",
                diagram,
                unlabelled[0],
                "unlabelled-solid-edge",
                `${unlabelled.length} solid edge(s) state no effect; first at ${sample}${unlabelled.length > 5 ? ", ..." : ""}`,
            ),
        )
    }

    if (labelVocabulary && !vocabularyApplies(diagram) && descriptive.length > 0) {
        findings.push(
            finding(
                "not-checked",
                "2",
                diagram,
                { line: descriptive[0].edge.line },
                "vocabulary-not-applicable",
                `${descriptive.length} solid label(s) use ${effectiveKind(diagram)}/${diagram.layer ?? "unlayered"} vocabulary; the declared categories bind only structure diagrams at L0 and L1`,
            ),
        )
    } else if (labelVocabulary && declaredHits.length === 0 && descriptive.length > 0) {
        findings.push(
            finding(
                "blocking",
                "2",
                diagram,
                { line: descriptive[0].edge.line },
                "diagram-uses-no-declared-label",
                `none of this diagram's ${descriptive.length} solid labels uses a declared category (${[...labelVocabulary].join(", ")}); first label: "${descriptive[0].label}"`,
            ),
        )
    } else if (descriptive.length > 0) {
        findings.push(
            finding(
                "not-checked",
                "2",
                diagram,
                { line: descriptive[0].edge.line },
                "descriptive-labels-accepted",
                `${descriptive.length} solid label(s) are descriptive rather than declared categories; the diagram does use declared categories, so they are accepted as detail`,
            ),
        )
    }

    // A dotted edge carries a completion or failure fact, or a state constraint.
    // An instruction drawn as a fact edge inverts the control model.
    for (const edge of diagram.edges) {
        if (edge.style !== "dotted") continue
        const classified = classifyDottedLabel(edge.label)
        if (classified.kind === "missing") {
            findings.push(
                finding(
                    "blocking",
                    "2",
                    diagram,
                    edge,
                    "unlabelled-dotted-edge",
                    `dotted edge ${edge.from} -.-> ${edge.to} states no fact or constraint`,
                ),
            )
            continue
        }
        if (classified.kind === "command") {
            findings.push(
                finding(
                    "blocking",
                    "2",
                    diagram,
                    edge,
                    "dotted-edge-carries-command",
                    `dotted label "${edge.label}" is an instruction ("${classified.imperative}"); facts and constraints only`,
                ),
            )
            continue
        }
        if (classified.kind === "unknown") {
            findings.push(
                finding(
                    "unverifiable",
                    "2",
                    diagram,
                    edge,
                    "dotted-edge-semantics-unknown",
                    `dotted label "${edge.label}" is neither a fact noun nor a constraint form`,
                ),
            )
        }
    }

    // Crossing a lifetime boundary without commit or write semantics hides where
    // authority moves. Nesting and cooperation inside one process scope are normal,
    // so a nested pair of lifetimes is not reported.
    const crossings = []
    for (const edge of diagram.edges) {
        const fromNode = diagram.nodes.get(edge.from)
        const toNode = diagram.nodes.get(edge.to)
        if (!fromNode || !toNode) continue
        const fromChain = subgraphChain(diagram, fromNode)
        const toChain = subgraphChain(diagram, toNode)
        if (fromChain.length === 0 || toChain.length === 0) continue
        const fromInner = fromChain.at(-1)
        const toInner = toChain.at(-1)
        if (fromInner.id === toInner.id) continue
        if (edge.style !== "solid") continue
        const nested =
            fromChain.some((ancestor) => ancestor.id === toInner.id) || toChain.some((ancestor) => ancestor.id === fromInner.id)
        if (nested) continue
        const label = (edge.label ?? "").toLowerCase()
        if (/\bcommit|\bwrite|\bpersist|\bdurable/.test(label)) continue
        crossings.push({ edge, from: fromInner.id, to: toInner.id })
    }
    // The spec does not declare which subgraphs contain which others, so a
    // crossing can be legitimate containment. Report once per diagram for review.
    if (crossings.length > 0) {
        const pairs = [...new Set(crossings.map((crossing) => `${crossing.from}->${crossing.to}`))]
        findings.push({
            ...finding(
                "not-checked",
                "2",
                diagram,
                crossings[0].edge,
                "cross-lifetime-review",
                `${crossings.length} edge(s) cross lifetimes (${pairs.slice(0, 6).join(", ")}${pairs.length > 6 ? ", ..." : ""}) without commit or write semantics; confirm each is containment rather than authority leakage`,
            ),
        })
    }

    return findings
}

// Dotted edges are checked for semantics, never for cycles.
export function summarizeDotted(diagram) {
    return dottedEdges(diagram).map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label,
        line: edge.line,
        kind: classifyDottedLabel(edge.label).kind,
    }))
}
