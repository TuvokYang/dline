// Stage 5 (B3): horizontal comparison across task diagrams.
// The merged graph is checked as one graph; pairwise reverse-edge checks cannot
// detect cycles of length three or greater.

import { canonicalNodeKey, identityAmbiguities } from "./architecture-identity.mjs"

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

function keyOf(diagram, nodeId) {
    return canonicalNodeKey(diagram, nodeId)
}

function stronglyConnectedComponents(outgoing) {
    let nextIndex = 0
    const indices = new Map()
    const lowLinks = new Map()
    const stack = []
    const onStack = new Set()
    const components = []

    const visit = (node) => {
        indices.set(node, nextIndex)
        lowLinks.set(node, nextIndex)
        nextIndex += 1
        stack.push(node)
        onStack.add(node)

        for (const target of outgoing.get(node) ?? []) {
            if (!indices.has(target)) {
                visit(target)
                lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)))
            } else if (onStack.has(target)) {
                lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)))
            }
        }

        if (lowLinks.get(node) !== indices.get(node)) return
        const component = []
        for (;;) {
            const member = stack.pop()
            onStack.delete(member)
            component.push(member)
            if (member === node) break
        }
        components.push(component)
    }

    for (const node of outgoing.keys()) {
        if (!indices.has(node)) visit(node)
    }
    return components
}

export function checkTaskHorizontally({ entries }) {
    const findings = []
    const owners = new Map()
    const directions = new Map()
    const outgoing = new Map()
    const edgeRecords = []

    for (const entry of entries) {
        const { taskId, diagram } = entry
        const excludedNodeIds = new Set([...diagram.localOnly, ...diagram.noteNodes])
        for (const ambiguity of identityAmbiguities(diagram)) {
            const sharedNodes = ambiguity.nodes.filter((node) => !excludedNodeIds.has(node.id))
            if (sharedNodes.length <= 1) continue
            findings.push(
                finding(
                    "blocking",
                    diagram,
                    ambiguity.nodes[0],
                    "task-node-identity-ambiguous",
                    `${taskId} has multiple nodes with canonical identity ${ambiguity.key}: ${sharedNodes.map((node) => node.id).join(", ")}`,
                    taskId,
                ),
            )
        }
        for (const node of diagram.nodes.values()) {
            if (excludedNodeIds.has(node.id)) continue
            const key = keyOf(diagram, node.id)
            if (!owners.has(key)) owners.set(key, [])
            owners.get(key).push({ taskId, node, diagram })
            if (!outgoing.has(key)) outgoing.set(key, new Set())
        }
        for (const edge of diagram.edges) {
            if (edge.style !== "solid") continue
            if (excludedNodeIds.has(edge.from) || excludedNodeIds.has(edge.to)) continue
            const fromKey = keyOf(diagram, edge.from)
            const toKey = keyOf(diagram, edge.to)
            const key = `${fromKey}->${toKey}`
            if (!directions.has(key)) directions.set(key, [])
            directions.get(key).push({ taskId, edge, diagram })
            if (!outgoing.has(fromKey)) outgoing.set(fromKey, new Set())
            if (!outgoing.has(toKey)) outgoing.set(toKey, new Set())
            outgoing.get(fromKey).add(toKey)
            edgeRecords.push({ taskId, diagram, edge, fromKey, toKey })
        }
    }

    for (const [key, claims] of directions) {
        const separator = key.indexOf("->")
        const fromKey = key.slice(0, separator)
        const toKey = key.slice(separator + 2)
        const reverse = directions.get(`${toKey}->${fromKey}`)
        if (!reverse) continue
        for (const claim of claims) {
            const conflict = reverse.find((candidate) => candidate.taskId !== claim.taskId)
            if (!conflict) continue
            findings.push(
                finding(
                    "blocking",
                    claim.diagram,
                    claim.edge,
                    "cross-task-edge-direction-conflict",
                    `${claim.taskId} draws ${claim.edge.from} -> ${claim.edge.to} while ${conflict.taskId} draws the reverse direction`,
                    claim.taskId,
                ),
            )
        }
    }

    for (const component of stronglyConnectedComponents(outgoing)) {
        const members = new Set(component)
        const internal = edgeRecords.filter((record) => members.has(record.fromKey) && members.has(record.toKey))
        const hasCycle = component.length > 1 || internal.some((record) => record.fromKey === record.toKey)
        if (!hasCycle) continue
        const tasks = [...new Set(internal.map((record) => record.taskId))].sort()
        if (tasks.length <= 1) continue
        const first = internal[0]
        findings.push(
            finding(
                "blocking",
                first?.diagram ?? null,
                first?.edge ?? null,
                "cross-task-cycle",
                `merging task diagrams forms a solid cycle across ${tasks.join(", ")}: ${component.slice().sort().join(" -> ")}`,
                tasks.join(","),
            ),
        )
    }

    for (const [key, claims] of owners) {
        const tasks = new Set(claims.map((claim) => claim.taskId))
        if (tasks.size <= 1) continue
        const shapes = new Set(claims.map((claim) => shapeOf(claim.node)))
        if (shapes.size <= 1) continue
        findings.push(
            finding(
                "unverifiable",
                claims[0].diagram,
                claims[0].node,
                "cross-task-node-shape-conflict",
                `node "${key}" is drawn with shapes ${[...shapes].join(", ")} across ${[...tasks].join(", ")}`,
                [...tasks].join(","),
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
