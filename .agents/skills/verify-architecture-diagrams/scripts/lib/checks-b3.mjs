// Stage 5 (B3): horizontal comparison across task diagrams.
// The merged graph is checked as one graph; pairwise reverse-edge checks cannot
// detect cycles of length three or greater.

import { buildDependencyGraph, checkDependencyCycles } from "./dependency-graph.mjs"

function shapeOf(node) {
    return node.shape === "bare" ? "rect" : node.shape
}

function finding(severity, diagram, subject, rule, message, task) {
    return {
        severity,
        attribution: "diagram",
        stage: "5",
        file: diagram?.file ?? null,
        line: subject?.line ?? diagram?.line ?? null,
        diagram: task ?? diagram?.answers ?? null,
        rule,
        message,
        task: task ?? null,
    }
}

export function checkTaskHorizontally({ entries, wsDiagrams = [] }) {
    const graph = buildDependencyGraph(entries, wsDiagrams)
    const findings = checkDependencyCycles(graph)
    for (const [key, claims] of graph.nodes) {
        const shared = claims.filter((claim) => !claim.local)
        const byDiagram = new Map()
        for (const claim of shared) {
            if (!byDiagram.has(claim.diagram)) byDiagram.set(claim.diagram, [])
            byDiagram.get(claim.diagram).push(claim)
        }
        for (const [diagram, same] of byDiagram) {
            if (same.length < 2) continue
            findings.push(
                finding(
                    "blocking",
                    diagram,
                    same[0].node,
                    "task-node-identity-ambiguous",
                    `multiple nodes resolve to ${key}: ${same.map((claim) => claim.node.id).join(", ")}`,
                    same[0].taskId,
                ),
            )
        }
        const tasks = new Set(shared.map((claim) => claim.taskId))
        const shapes = new Set(shared.map((claim) => shapeOf(claim.node)))
        if (tasks.size > 1 && shapes.size > 1) {
            findings.push(
                finding(
                    "unverifiable",
                    shared[0].diagram,
                    shared[0].node,
                    "cross-task-node-shape-conflict",
                    `node "${key}" is drawn with shapes ${[...shapes].join(", ")} across ${[...tasks].join(", ")}`,
                    [...tasks].join(","),
                ),
            )
        }
    }
    for (const record of graph.edges) {
        const reverse = graph.edges.find(
            (candidate) => candidate.from === record.to && candidate.to === record.from && candidate.taskId !== record.taskId,
        )
        if (!reverse) continue
        findings.push(
            finding(
                "blocking",
                record.diagram,
                record.edge,
                "cross-task-edge-direction-conflict",
                `${record.taskId} draws ${record.edge.from} -> ${record.edge.to} while ${reverse.taskId} draws the reverse structural direction`,
                record.taskId,
            ),
        )
    }
    return dedupe(findings)
}

function dedupe(findings) {
    const seen = new Set()
    const unique = []
    for (const item of findings) {
        const key = `${item.rule}|${item.task}|${item.message}`
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(item)
    }
    return unique
}
