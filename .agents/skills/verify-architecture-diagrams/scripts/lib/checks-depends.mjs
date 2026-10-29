// Stage 5 (B3 extension): the plan's Task Graph against the Workstream diagrams.
// A declared dependency must be explained by at least one solid edge from an
// upstream-owned node to a downstream-owned node. Sharing one node is zero hops
// and therefore is not evidence of ordering.

import { canonicalNodeKey } from "./architecture-identity.mjs"
import { resolveNode } from "./checks-interlevel.mjs"
import { graphNodeIds } from "./mermaid-parse.mjs"

function canonicalPath(value) {
    return String(value ?? "")
        .normalize("NFKC")
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
        .toLowerCase()
}

function identityKey(diagram, nodeId) {
    return canonicalNodeKey(diagram, nodeId)
}

export function mergedWorkstreamGraph(wsDiagrams) {
    const outgoing = new Map()
    for (const diagram of wsDiagrams) {
        const members = new Set(graphNodeIds(diagram))
        for (const nodeId of members) {
            const key = identityKey(diagram, nodeId)
            if (!outgoing.has(key)) outgoing.set(key, new Set())
        }
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

export function hasNonZeroPath(outgoing, sources, targets) {
    const wanted = new Set(targets)
    const seen = new Set()
    const queue = []
    for (const source of sources) {
        for (const next of outgoing.get(source) ?? []) queue.push(next)
    }
    while (queue.length > 0) {
        const current = queue.shift()
        if (seen.has(current)) continue
        seen.add(current)
        if (wanted.has(current)) return true
        for (const next of outgoing.get(current) ?? []) queue.push(next)
    }
    return false
}

function nodeArtifacts(task, diagram, nodeId) {
    const artifacts = [...(diagram.artifacts?.get(nodeId) ?? [])]
    if (task.architectureEvidence?.diagramId === diagram.id) {
        artifacts.push(...(task.architectureEvidence.nodes.get(nodeId)?.artifacts ?? []))
    }
    return artifacts
}

function taskOwnsPath(task, artifactPath) {
    const wanted = canonicalPath(artifactPath)
    return task.owns.some((boundary) => canonicalPath(boundary.path) === wanted)
}

// Resolve only nodes that the task may write through an explicitly bound artifact.
// `owns` remains permission; it does not create an artifact or authority claim.
function taskOwnedIdentities(task, wsDiagrams) {
    const keys = new Set()
    for (const parsed of task.diagrams) {
        if (parsed.problems.length > 0 || parsed.diagram.ignored) continue
        const diagram = parsed.diagram
        for (const nodeId of graphNodeIds(diagram)) {
            if (diagram.localOnly.has(nodeId)) continue
            const artifacts = nodeArtifacts(task, diagram, nodeId)
            if (!artifacts.some((artifact) => artifact.path && taskOwnsPath(task, artifact.path))) continue
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
    for (const task of tasks.values()) identities.set(task.id, taskOwnedIdentities(task, wsDiagrams))

    let unanchored = 0
    for (const row of planGraph.tasks) {
        const downstream = identities.get(row.id)
        for (const dependency of row.dependsOn) {
            if (dependency.includes("/")) continue
            const upstream = identities.get(dependency)
            if (!downstream || !upstream || downstream.size === 0 || upstream.size === 0) {
                unanchored += 1
                continue
            }
            if (hasNonZeroPath(outgoing, upstream, downstream)) continue
            findings.push(
                finding(
                    "unverifiable",
                    "depends-on-not-explained-by-diagram",
                    `${row.id} depends on ${dependency}, but no nonzero solid Workstream path leads from an artifact-owned ${dependency} node to an artifact-owned ${row.id} node`,
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
                `${unanchored} dependency edge(s) lack an artifact-owned node on one side, so their nonzero reachability is not verified`,
                null,
                planPath,
                null,
            ),
        )
    }
    return findings
}
