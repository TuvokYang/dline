// Stage 5 (B3 extension): the plan's Task Graph against the Workstream diagrams.
// `Depends On` must be a subset of the diagrams' solid reachability: when task B
// depends on task A, some node A draws must reach some node B draws through
// solid Workstream edges. A dependency the diagrams cannot explain means either
// the diagram omits an edge or the task cut is wrong.

import { resolveNode } from "./checks-interlevel.mjs"
import { graphNodeIds } from "./mermaid-parse.mjs"

function normalize(label) {
    return (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

// Stable identity of a Workstream node across diagrams: declared concept,
// else normalized label, else id. Different diagrams name one thing differently.
function identityKey(diagram, nodeId) {
    const concept = diagram.concepts.get(nodeId)
    if (concept) return `c:${normalize(concept)}`
    const label = normalize(diagram.nodes.get(nodeId)?.label)
    if (label) return `l:${label}`
    return `i:${normalize(nodeId)}`
}

// Merge every Workstream diagram's solid edges into one graph keyed by identity.
export function mergedWorkstreamGraph(wsDiagrams) {
    const outgoing = new Map()
    for (const diagram of wsDiagrams) {
        const members = new Set(graphNodeIds(diagram))
        for (const edge of diagram.edges) {
            if (edge.style !== "solid") continue
            if (!members.has(edge.from) || !members.has(edge.to)) continue
            const from = identityKey(diagram, edge.from)
            const to = identityKey(diagram, edge.to)
            if (!outgoing.has(from)) outgoing.set(from, new Set())
            outgoing.get(from).add(to)
            if (!outgoing.has(to)) outgoing.set(to, new Set())
        }
    }
    return outgoing
}

function reaches(outgoing, sources, targets) {
    const wanted = new Set(targets)
    const seen = new Set()
    const queue = [...sources]
    while (queue.length > 0) {
        const current = queue.shift()
        if (seen.has(current)) continue
        seen.add(current)
        if (wanted.has(current)) return true
        for (const next of outgoing.get(current) ?? []) queue.push(next)
    }
    return false
}

// The Workstream identities a task's diagrams touch, resolved through any Workstream diagram.
function taskIdentities(task, wsDiagrams) {
    const keys = new Set()
    for (const parsed of task.diagrams) {
        if (parsed.problems.length > 0 || parsed.diagram.ignored) continue
        const diagram = parsed.diagram
        for (const nodeId of graphNodeIds(diagram)) {
            if (diagram.localOnly.has(nodeId)) continue
            const node = diagram.nodes.get(nodeId)
            for (const wsDiagram of wsDiagrams) {
                const match = resolveNode(node, wsDiagram, diagram)
                if (match.node) keys.add(identityKey(wsDiagram, match.node.id))
            }
        }
    }
    return keys
}

function finding(severity, rule, message, task, file, line) {
    return {
        severity,
        attribution: "diagram",
        stage: "5",
        file: file ?? null,
        line: line ?? null,
        diagram: task ?? null,
        rule,
        message,
        task: task ?? null,
    }
}

export function checkDependsOnReachability({ tasks, planGraph, wsDiagrams, planPath }) {
    const findings = []
    if (!planGraph || planGraph.error || planGraph.tasks.length === 0) return findings
    const outgoing = mergedWorkstreamGraph(wsDiagrams)
    const identities = new Map()
    for (const task of tasks.values()) identities.set(task.id, taskIdentities(task, wsDiagrams))

    let unanchored = 0
    for (const row of planGraph.tasks) {
        const downstream = identities.get(row.id)
        for (const dependency of row.dependsOn) {
            // Cross-Workstream dependencies name another contract; the local diagrams cannot judge them.
            if (dependency.includes("/")) continue
            const upstream = identities.get(dependency)
            if (!downstream || !upstream || downstream.size === 0 || upstream.size === 0) {
                unanchored += 1
                continue
            }
            if (reaches(outgoing, upstream, downstream)) continue
            findings.push(
                finding(
                    "unverifiable",
                    "depends-on-not-explained-by-diagram",
                    `${row.id} depends on ${dependency}, but no solid Workstream edge path leads from a node ${dependency} draws to a node ${row.id} draws; add the missing edge or correct the task cut`,
                    row.id,
                    planPath,
                    row.line,
                ),
            )
        }
    }
    if (unanchored > 0) {
        findings.push(
            finding(
                "not-checked",
                "depends-on-unanchored",
                `${unanchored} dependency edge(s) involve a task with no readable diagram anchored to the Workstream, so their reachability is not verified`,
                null,
                planPath,
                null,
            ),
        )
    }
    return findings
}
