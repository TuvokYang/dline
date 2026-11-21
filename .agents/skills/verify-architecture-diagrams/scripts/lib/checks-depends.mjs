// Stage 5 (B3 extension): the plan's Task Graph against the Workstream diagrams.
// A declared dependency must be explained by at least one solid edge from an
// upstream-owned node to a downstream-owned node. Sharing one node is zero hops
// and therefore is not evidence of ordering.

import { resolveNode } from "./checks-interlevel.mjs"
import { buildDependencyGraph } from "./dependency-graph.mjs"
import { graphNodeIds } from "./mermaid-parse.mjs"

function canonicalPath(value) {
    return String(value ?? "")
        .normalize("NFKC")
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
        .toLowerCase()
}

export function mergedWorkstreamGraph(wsDiagrams) {
    return buildDependencyGraph(wsDiagrams.map((diagram) => ({ diagram }))).outgoing
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
    return task.owns.some((boundary) => {
        const root = canonicalPath(boundary.path).replace(/\/$/, "")
        return root === wanted || (boundary.kind === "module" && wanted.startsWith(`${root}/`))
    })
}

// Resolve only nodes that the task may write through an explicitly bound artifact.
// `owns` remains permission; it does not create an artifact or authority claim.
function taskOwnedIdentities(task, wsDiagrams, resolver) {
    const keys = new Set()
    for (const parsed of task.diagrams) {
        if (parsed.problems.length > 0 || parsed.diagram.ignored) continue
        const diagram = parsed.diagram
        for (const nodeId of graphNodeIds(diagram)) {
            if (diagram.localOnly.has(nodeId)) continue
            const artifacts = nodeArtifacts(task, diagram, nodeId)
            if (!artifacts.some((artifact) => artifact.path && taskOwnsPath(task, artifact.path))) continue
            const node = diagram.nodes.get(nodeId)
            const references = diagram.refines?.length
                ? wsDiagrams.filter((parent) => diagram.refines.includes(parent.id))
                : wsDiagrams
            for (const wsDiagram of references) {
                const match = resolveNode(node, wsDiagram, diagram)
                if (!match.node) continue
                const key = resolver.keyOf(wsDiagram, match.node.id)
                if (key !== null) keys.add(key)
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

function coversRead(owned, read) {
    const root = canonicalPath(owned.path).replace(/\/$/, "")
    const target = canonicalPath(read.path)
    if (owned.kind === "module") return target === root || target.startsWith(`${root}/`)
    if (target !== root) return false
    if (owned.kind === "whole_file") return true
    return (
        owned.kind === "symbol" &&
        read.kind === "symbol" &&
        owned.selector &&
        read.selector &&
        (read.selector === owned.selector || read.selector.startsWith(`${owned.selector}.`))
    )
}

function checkConsumedTasks(tasks, planGraph, planPath) {
    const findings = []
    const prerequisites = new Map(planGraph.tasks.map((row) => [row.id, new Set(row.dependsOn)]))
    // Write permission alone does not establish production of an interface.
    // Require an explicit architectural artifact owned by that Task as well.
    const boundaries = [...tasks.values()].flatMap((task) =>
        task.diagrams.flatMap((parsed) => {
            if (parsed.problems.length || parsed.diagram.ignored) return []
            return [...parsed.diagram.nodes.keys()]
                .flatMap((nodeId) => nodeArtifacts(task, parsed.diagram, nodeId))
                .filter(
                    (artifact) =>
                        ["declaration", "writer", "generated"].includes(artifact.role) &&
                        artifact.inspection !== "support" &&
                        task.owns.some((owned) =>
                            coversRead(owned, {
                                path: artifact.path,
                                kind: artifact.symbol ? "symbol" : "module",
                                selector: artifact.symbol,
                            }),
                        ),
                )
                .map((artifact) => ({
                    task,
                    owned: {
                        path: artifact.path,
                        kind: artifact.symbol ? "symbol" : "module",
                        selector: artifact.symbol,
                    },
                }))
        }),
    )
    const seen = new Set()
    for (const consumer of tasks.values()) {
        for (const read of consumer.reads ?? []) {
            const matches = boundaries.filter(({ owned }) => coversRead(owned, read))
            if (matches.length === 0) continue
            const depth = Math.max(...matches.map(({ owned }) => canonicalPath(owned.path).length))
            const producers = new Set(
                matches.filter(({ owned }) => canonicalPath(owned.path).length === depth).map(({ task }) => task.id),
            )
            for (const producer of producers) {
                if (producer === consumer.id || hasNonZeroPath(prerequisites, [consumer.id], [producer])) continue
                const key = `${consumer.id}:${producer}:${read.path}`
                if (seen.has(key)) continue
                seen.add(key)
                findings.push(
                    finding(
                        "blocking",
                        "task-consumption-undeclared",
                        `${consumer.id} declares a read of ${read.path} produced within ${producer}'s boundary, but its dependency DAG has no prerequisite path to ${producer}`,
                        consumer.id,
                        planPath,
                        planGraph.tasks.find((row) => row.id === consumer.id)?.line,
                    ),
                )
            }
        }
    }
    return findings
}

export function checkDependsOnReachability({ tasks, planGraph, wsDiagrams, planPath }) {
    const findings = []
    if (!planGraph || planGraph.error || planGraph.tasks.length === 0) return findings
    const graph = buildDependencyGraph(wsDiagrams.map((diagram) => ({ diagram })))
    const outgoing = graph.outgoing
    findings.push(...graph.resolver.findings, ...checkConsumedTasks(tasks, planGraph, planPath))
    const identities = new Map()
    for (const task of tasks.values()) identities.set(task.id, taskOwnedIdentities(task, wsDiagrams, graph.resolver))

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
