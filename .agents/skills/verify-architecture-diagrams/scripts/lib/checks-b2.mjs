// Stage 4 (B2): task diagram against the Workstream diagram.
// Existence defects belong to the Workstream; coverage defects belong to the task.

import { resolveNode } from "./checks-interlevel.mjs"
import { effectiveKind } from "./checks-intra.mjs"

const VOCABULARY_LAYERS = new Set(["L0", "L1"])

function normalize(label) {
    return (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function finding(severity, attribution, diagram, subject, rule, message, taskId) {
    return {
        severity,
        attribution,
        stage: "4",
        file: diagram.file,
        line: subject?.line ?? diagram.line,
        diagram: taskId ? `${taskId}` : (diagram.answers ?? diagram.layer ?? diagram.file),
        rule,
        message,
        task: taskId ?? null,
    }
}

// A task diagram refines the Workstream diagram it names with %% refines:.
// Without that declaration the verifier falls back to the diagram that overlaps
// it most and says so, because an inferred anchor is a weaker claim.
export function pickWorkstreamReference(taskDiagram, wsDiagrams) {
    for (const wanted of taskDiagram.refines ?? []) {
        const declared = wsDiagrams.find((candidate) => candidate.id === wanted)
        if (declared) return { diagram: declared, declared: true }
    }
    let best = null
    for (const wsDiagram of wsDiagrams) {
        let overlap = 0
        for (const node of taskDiagram.nodes.values()) {
            if (resolveNode(node, wsDiagram, taskDiagram).node) overlap += 1
        }
        if (!best || overlap > best.overlap) best = { diagram: wsDiagram, overlap }
    }
    return best && best.overlap > 0 ? { diagram: best.diagram, declared: false } : null
}

export function checkTaskAgainstWorkstream({ taskId, taskDiagram, wsDiagrams, labelVocabulary, specText }) {
    const findings = []
    const reference = pickWorkstreamReference(taskDiagram, wsDiagrams)

    if (!reference) {
        findings.push(
            finding(
                "unverifiable",
                "diagram",
                taskDiagram,
                null,
                "task-diagram-unmapped",
                "no Workstream diagram shares any node with this task diagram; the task is not anchored to the contract",
                taskId,
            ),
        )
        return findings
    }

    const wsDiagram = reference.diagram
    if (!reference.declared) {
        findings.push(
            finding(
                "not-checked",
                "diagram",
                taskDiagram,
                null,
                "workstream-reference-inferred",
                `anchored to Workstream diagram ${wsDiagram.id ?? `${wsDiagram.file}:${wsDiagram.line}`} by node overlap; declare %% refines: <id> to make the anchor explicit`,
                taskId,
            ),
        )
    }
    const wsNodeIds = new Set(wsDiagram.nodes.keys())
    const wsLabels = new Map()
    for (const node of wsDiagram.nodes.values()) wsLabels.set(normalize(node.label), node.id)

    const resolved = new Map()
    for (const taskNode of taskDiagram.nodes.values()) {
        if (taskDiagram.localOnly.has(taskNode.id)) continue
        if (taskDiagram.noteNodes.has(taskNode.id)) continue
        const match = resolveNode(taskNode, wsDiagram, taskDiagram)
        if (match.node) {
            resolved.set(taskNode.id, match.node.id)
            continue
        }
        findings.push(
            finding(
                "blocking",
                "diagram",
                taskDiagram,
                { line: taskNode.line },
                "task-node-not-in-workstream",
                `task node ${taskNode.id} ("${taskNode.label ?? ""}") is neither a Workstream node nor declared %% local-only`,
                taskId,
            ),
        )
    }

    for (const edge of taskDiagram.edges) {
        const from = resolved.get(edge.from)
        const to = resolved.get(edge.to)
        if (!from || !to) continue
        const wsEdge = wsDiagram.edges.find((candidate) => candidate.from === from && candidate.to === to)
        if (!wsEdge) {
            const reverse =
                edge.style === "solid"
                    ? wsDiagram.edges.find(
                          (candidate) => candidate.from === to && candidate.to === from && candidate.style === "solid",
                      )
                    : null
            findings.push(
                finding(
                    edge.style === "solid" ? "blocking" : "not-checked",
                    "diagram",
                    taskDiagram,
                    edge,
                    reverse ? "task-edge-inverted" : edge.style === "solid" ? "task-edge-undeclared" : "task-extra-fact-edge",
                    reverse
                        ? `task draws ${edge.from} -> ${edge.to} where the Workstream declares the reverse direction`
                        : edge.style === "solid"
                          ? `task draws ${edge.from} -> ${edge.to}, which the Workstream diagram does not declare`
                          : `task adds fact edge ${edge.from} -.-> ${edge.to} that the Workstream diagram does not state`,
                    taskId,
                ),
            )
            continue
        }
        if (wsEdge.style === "solid" && edge.style === "dotted") {
            findings.push(
                finding(
                    "blocking",
                    "diagram",
                    taskDiagram,
                    edge,
                    "task-edge-style-downgraded",
                    `task draws a fact edge where the Workstream declares a command edge`,
                    taskId,
                ),
            )
        }
        // The declared categories bind structure diagrams at L0/L1; a flow or
        // deeper diagram describes behaviour in its own vocabulary.
        const vocabularyApplies =
            effectiveKind(taskDiagram) === "structure" && (taskDiagram.layer === null || VOCABULARY_LAYERS.has(taskDiagram.layer))
        if (edge.style === "solid" && edge.label && labelVocabulary && vocabularyApplies && !labelVocabulary.has(edge.label)) {
            findings.push(
                finding(
                    "blocking",
                    "diagram",
                    taskDiagram,
                    edge,
                    "task-solid-label-outside-vocabulary",
                    `solid label "${edge.label}" is not declared in the Workstream normative label sentence`,
                    taskId,
                ),
            )
        }
    }

    // Lifetime scopes a task introduces must be declared as local refinement.
    for (const subgraph of taskDiagram.subgraphs) {
        const known = wsDiagram.subgraphs.some((candidate) => normalize(candidate.label) === normalize(subgraph.label))
        if (known) continue
        if (taskDiagram.localOnly.has(subgraph.id)) continue
        findings.push(
            finding(
                "blocking",
                "diagram",
                taskDiagram,
                { line: subgraph.line },
                "task-lifetime-not-in-workstream",
                `subgraph "${subgraph.label}" has no Workstream counterpart and is not declared %% local-only`,
                taskId,
            ),
        )
    }

    // Unverified nodes must name their owning task, which is the contract the Workstream keeps.
    for (const node of taskDiagram.nodes.values()) {
        const label = (node.label ?? "").toLowerCase()
        if (!label.includes("not yet verified")) continue
        const hasOwner =
            /task-\d+/i.test(node.label ?? "") ||
            [...taskDiagram.nodes.values()].some((other) => /task-\d+/i.test(other.label ?? "")) ||
            /(owner|归|归口)/i.test(specText ?? "")
        if (!hasOwner) {
            findings.push(
                finding(
                    "unverifiable",
                    "diagram",
                    taskDiagram,
                    { line: node.line },
                    "unverified-node-without-owner",
                    `node ${node.id} is marked "not yet verified" but names no owning task`,
                    taskId,
                ),
            )
        }
    }

    void wsNodeIds
    void wsLabels
    return findings
}
