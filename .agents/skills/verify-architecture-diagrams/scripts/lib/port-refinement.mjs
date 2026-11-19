// Refinements may select a boundary view, not silently change its port contract.
import { resolveArchitectureNode } from "./architecture-identity.mjs"

export function checkPortRefinement(coarse, fine) {
    if (!coarse.portContracts?.enabled || !fine.portContracts?.enabled) return []
    const findings = []
    const report = (subject, rule, message) =>
        findings.push({
            severity: "blocking",
            attribution: "diagram",
            stage: "3",
            file: fine.file,
            line: subject.line ?? fine.line,
            diagram: fine.id,
            rule,
            message,
        })
    const subjects = new Set([...fine.portContracts.ports.keys(), ...fine.portContracts.inventories.keys()])
    for (const nodeId of subjects) {
        const ports = fine.portContracts.ports.get(nodeId) ?? new Map()
        if (fine.localOnly.has(nodeId) || fine.noteNodes.has(nodeId)) continue
        const node = fine.nodes.get(nodeId)
        if (!node) continue
        const parent = resolveArchitectureNode(node, coarse, fine).node
        if (!parent) continue
        const inherited = coarse.portContracts.ports.get(parent.id)
        const complete = coarse.portContracts.inventories.get(parent.id)?.completeness === "complete"
        for (const port of ports.values()) {
            const original = inherited?.get(port.id)
            if (!original) {
                if (complete)
                    report(
                        port,
                        "port-undeclared-upstream",
                        `${nodeId}.${port.id} is absent from complete boundary ${coarse.id}:${parent.id}`,
                    )
                continue
            }
            if (port.mode !== original.mode || port.type !== original.type || (original.required && !port.required)) {
                report(
                    port,
                    "port-contract-changed",
                    `${nodeId}.${port.id} changes the mode, nominal type or required obligation declared by ${coarse.id}:${parent.id}.${port.id}`,
                )
            }
        }
        if (fine.portContracts.inventories.get(nodeId)?.completeness !== "complete") continue
        for (const original of inherited?.values() ?? []) {
            if (original.required && !ports.has(original.id)) {
                report(
                    node,
                    "port-required-omitted",
                    `complete refinement ${nodeId} omits required boundary port ${coarse.id}:${parent.id}.${original.id}`,
                )
            }
        }
    }
    return findings
}
