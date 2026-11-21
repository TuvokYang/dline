// Structural dependencies only: flow edges are protocol steps, not references.
import { createDiagramResolver } from "./architecture-identity.mjs"
import { effectiveKind } from "./checks-intra.mjs"
import { cyclePath, findCycles } from "./graph.mjs"

export function buildDependencyGraph(entries, anchors = []) {
    const diagrams = entries.map((entry) => entry.diagram)
    const resolver = createDiagramResolver(diagrams, anchors)
    const nodes = new Map()
    const edges = []
    for (const entry of entries) {
        const { diagram } = entry
        if (diagram.ignored || effectiveKind(diagram) !== "structure") continue
        for (const node of diagram.nodes.values()) {
            const key = resolver.keyOf(diagram, node.id)
            if (key === null) continue
            if (!nodes.has(key)) nodes.set(key, [])
            nodes.get(key).push({ ...entry, node, local: diagram.localOnly.has(node.id) })
        }
        for (const edge of diagram.edges) {
            if (edge.style !== "solid") continue
            const from = resolver.keyOf(diagram, edge.from)
            const to = resolver.keyOf(diagram, edge.to)
            if (from === null || to === null) continue
            edges.push({ ...entry, edge, from, to })
        }
    }
    const outgoing = new Map([...nodes.keys()].map((key) => [key, new Set()]))
    for (const edge of edges) outgoing.get(edge.from).add(edge.to)
    return { nodes, edges, outgoing, resolver }
}

function exactExemption(component, records, resolver) {
    const members = new Set(component)
    return records.some(({ diagram }) =>
        diagram.cycleAllowed.some((declaration) => {
            if (!declaration.owner || !declaration.reason || declaration.nodes.length !== members.size) return false
            const keys = declaration.nodes.map((node) => resolver.keyOf(diagram, node))
            return new Set(keys).size === members.size && keys.every((key) => members.has(key))
        }),
    )
}

export function checkDependencyCycles(graph, scope = "task") {
    const findings = [...graph.resolver.findings]
    for (const component of findCycles([...graph.nodes.keys()], graph.edges).components) {
        const members = new Set(component)
        const records = graph.edges.filter((edge) => members.has(edge.from) && members.has(edge.to))
        // The single-diagram checker owns local SCCs and their exemptions.
        if (new Set(records.map((edge) => edge.diagram)).size < 2) continue
        const tasks = [...new Set(records.map((edge) => edge.taskId).filter(Boolean))].sort()
        const exempted = exactExemption(component, records, graph.resolver)
        const first = records[0]
        const trail = cyclePath(component, graph.edges).join(" -> ")
        const sources = [...new Set(records.map(({ diagram, edge }) => `${diagram.id ?? diagram.file}:${edge.line}`))].sort()
        findings.push({
            severity: exempted ? "not-checked" : "blocking",
            attribution: "diagram",
            stage: scope === "workstream" ? "1" : "5",
            file: first.diagram.file,
            line: first.edge.line,
            diagram: first.diagram.id ?? first.diagram.answers,
            task: tasks.join(",") || null,
            rule: exempted
                ? "dependency-cycle-exempted"
                : scope === "workstream"
                  ? "workstream-cycle"
                  : tasks.length > 1
                    ? "cross-task-cycle"
                    : "cross-diagram-cycle",
            message: `${scope} structural cycle${tasks.length ? ` across ${tasks.join(", ")}` : ""}: ${trail}; sources: ${sources.join(", ")}${exempted ? "; exact declared SCC exemption" : ""}`,
        })
    }
    return findings
}
