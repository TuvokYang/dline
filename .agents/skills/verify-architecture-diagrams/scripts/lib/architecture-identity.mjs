// Canonical identity shared by every diagram comparison stage.
// NFKC closes compatibility spelling gaps; only Unicode letters and numbers
// remain so punctuation, symbols and whitespace cannot create false identities.

export function normalizeArchitectureIdentity(value) {
    return (
        String(value ?? "")
            .normalize("NFKC")
            .toLocaleLowerCase("und")
            .match(/[\p{L}\p{N}]/gu)
            ?.join("") ?? ""
    )
}

function uniqueNodes(nodes) {
    const seen = new Set()
    return nodes.filter((node) => {
        if (seen.has(node.id)) return false
        seen.add(node.id)
        return true
    })
}

function resolution(candidates, strategy) {
    const unique = uniqueNodes(candidates)
    if (unique.length === 1) return { node: unique[0], strategy, candidates: unique }
    if (unique.length > 1) return { node: null, strategy: `ambiguous-${strategy}`, candidates: unique }
    return null
}

export function canonicalNodeKey(diagram, nodeId) {
    const concept = normalizeArchitectureIdentity(diagram?.concepts?.get(nodeId))
    if (concept) return `concept:${concept}`
    const label = normalizeArchitectureIdentity(diagram?.nodes?.get(nodeId)?.label)
    if (label) return `node:${label}`
    return `node:${normalizeArchitectureIdentity(nodeId)}`
}

export function resolveArchitectureNode(fineNode, coarseDiagram, fineDiagram = null) {
    const concept = normalizeArchitectureIdentity(fineDiagram?.concepts?.get(fineNode.id))
    if (concept) {
        const conceptMatches = []
        for (const candidate of coarseDiagram.nodes.values()) {
            const values = [coarseDiagram.concepts?.get(candidate.id), candidate.id, candidate.label].map(
                normalizeArchitectureIdentity,
            )
            if (values.includes(concept)) conceptMatches.push(candidate)
        }
        const matched = resolution(conceptMatches, "concept")
        if (matched) return matched
    }

    const exact = coarseDiagram.nodes.get(fineNode.id)
    if (exact) return { node: exact, strategy: "id", candidates: [exact] }

    const label = normalizeArchitectureIdentity(fineNode.label)
    if (label) {
        const labelMatches = [...coarseDiagram.nodes.values()].filter(
            (candidate) => normalizeArchitectureIdentity(candidate.label) === label,
        )
        const matched = resolution(labelMatches, "label")
        if (matched) return matched
    }

    return { node: null, strategy: "unresolved", candidates: [] }
}

export function identityAmbiguities(diagram) {
    const groups = new Map()
    for (const node of diagram.nodes.values()) {
        const key = canonicalNodeKey(diagram, node.id)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(node)
    }
    return [...groups.entries()].filter(([, nodes]) => nodes.length > 1).map(([key, nodes]) => ({ key, nodes }))
}
