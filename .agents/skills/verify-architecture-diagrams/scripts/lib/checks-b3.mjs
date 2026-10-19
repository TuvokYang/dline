// Stage 5 (B3): horizontal comparison across task diagrams.
// Two tasks that disagree about one node mean the Workstream cut is wrong.

function normalize(label) {
    return (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

// Only a command verb makes an edge a canonical write. Participles and nouns such as
// "committed facts", "persisted record" or "writer" describe data or a role, not a write
// into the target.
const CANONICAL_WRITE = /\b(commit|commits|committing|write|writes|writing|persist|persists|persisting)\b/

// Mermaid renders a node declared without brackets as a rectangle labelled with its id.
function shapeOf(node) {
    return node.shape === "bare" ? "rect" : node.shape
}

function keyOf(diagram, id) {
    return normalize(diagram.nodes.get(id)?.label) || normalize(id)
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

// Identity key for cross-task comparison: normalized id or normalized label.
function identityOf(diagram) {
    const map = new Map()
    for (const node of diagram.nodes.values()) {
        const key = normalize(node.label) || normalize(node.id)
        map.set(key, { node, id: node.id })
    }
    return map
}

export function checkTaskHorizontally({ entries }) {
    const findings = []
    const owners = new Map()
    const directions = new Map()
    const writers = new Map()

    for (const entry of entries) {
        const { taskId, diagram } = entry
        const identity = identityOf(diagram)
        for (const [key, { node }] of identity) {
            if (!owners.has(key)) owners.set(key, [])
            owners.get(key).push({ taskId, node, diagram })
        }
        // A solid command answered by a dotted fact in the opposite direction is the normal
        // command/report pair, so only solid edges can contradict each other's direction.
        for (const edge of diagram.edges) {
            if (edge.style !== "solid") continue
            const fromKey = keyOf(diagram, edge.from)
            const toKey = keyOf(diagram, edge.to)
            const key = `${fromKey}->${toKey}`
            if (!directions.has(key)) directions.set(key, [])
            directions.get(key).push({ taskId, edge, diagram })
            const reverseKey = `${toKey}->${fromKey}`
            if (directions.has(reverseKey)) {
                const conflict = directions.get(reverseKey).find((candidate) => candidate.taskId !== taskId)
                if (conflict) {
                    findings.push(
                        finding(
                            "blocking",
                            diagram,
                            edge,
                            "cross-task-edge-direction-conflict",
                            `${taskId} draws ${edge.from} -> ${edge.to} while ${conflict.taskId} draws the reverse direction`,
                            taskId,
                        ),
                    )
                }
            }
        }

        // A node that commits canonical state is a writer; two writers for one identity are a split authority.
        for (const edge of diagram.edges) {
            if (edge.style !== "solid") continue
            const label = (edge.label ?? "").toLowerCase()
            if (!CANONICAL_WRITE.test(label)) continue
            const toKey = keyOf(diagram, edge.to)
            if (!writers.has(toKey)) writers.set(toKey, [])
            writers.get(toKey).push({ taskId, writer: edge.from, writerKey: keyOf(diagram, edge.from) })
        }
    }

    for (const [key, claims] of writers) {
        const taskSet = new Set(claims.map((claim) => claim.taskId))
        if (taskSet.size <= 1) continue
        // The same writer drawn by several tasks is still one authority.
        const writerIdentities = new Set(claims.map((claim) => claim.writerKey))
        if (writerIdentities.size <= 1) continue
        const uniqueWriters = new Set(claims.map((claim) => `${claim.taskId}:${claim.writer}`))
        findings.push(
            finding(
                "blocking",
                null,
                null,
                "cross-task-split-authority",
                `node "${key}" receives canonical writes from ${[...uniqueWriters].join(", ")}`,
                [...taskSet].join(","),
            ),
        )
    }

    // Runtime cycles that appear only when task graphs are merged mean the cut is wrong.
    for (const entry of entries) {
        for (const edge of entry.diagram.edges) {
            if (edge.style !== "solid") continue
            const fromKey = normalize(entry.diagram.nodes.get(edge.from)?.label) || normalize(edge.from)
            const toKey = normalize(entry.diagram.nodes.get(edge.to)?.label) || normalize(edge.to)
            if (fromKey === toKey) continue
            const reverse = findMergedReverse(entries, entry.taskId, toKey, fromKey)
            if (!reverse) continue
            findings.push(
                finding(
                    "blocking",
                    entry.diagram,
                    edge,
                    "cross-task-cycle",
                    `merging task diagrams forms a cycle ${entry.diagram.nodes.get(edge.from)?.label ?? edge.from} -> ${entry.diagram.nodes.get(edge.to)?.label ?? edge.to} -> back via ${reverse.taskId}`,
                    entry.taskId,
                ),
            )
        }
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

function findMergedReverse(entries, taskId, fromKey, toKey) {
    for (const entry of entries) {
        if (entry.taskId === taskId) continue
        for (const edge of entry.diagram.edges) {
            if (edge.style !== "solid") continue
            const edgeFrom = normalize(entry.diagram.nodes.get(edge.from)?.label) || normalize(edge.from)
            const edgeTo = normalize(entry.diagram.nodes.get(edge.to)?.label) || normalize(edge.to)
            if (edgeFrom === fromKey && edgeTo === toKey) return { taskId: entry.taskId, edge }
        }
    }
    return null
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
