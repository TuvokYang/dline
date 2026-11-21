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
        // An explicit identity cannot silently become an unrelated same-name node.
        return resolution(conceptMatches, "concept") ?? { node: null, strategy: "unresolved-concept", candidates: [] }
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

// Resolve graph identities through the same explicit parents used by B1/B2.
// A local id is scoped to its diagram, never promoted to a shared authority.
export function createDiagramResolver(diagrams, anchors = []) {
    const all = [...new Set([...anchors, ...diagrams])]
    const records = new Map()
    const byId = new Map()
    const findings = []
    for (const [index, diagram] of all.entries()) {
        if (diagram.id) {
            if (!byId.has(diagram.id)) byId.set(diagram.id, [])
            byId.get(diagram.id).push(diagram)
        }
        const nodes = new Map()
        for (const node of diagram.nodes.values()) {
            if (diagram.noteNodes.has(node.id)) continue
            const record = {
                diagram,
                node,
                scope: `${diagram.file}:${diagram.id ?? diagram.line ?? index}:${node.id}`,
                local: diagram.localOnly.has(node.id),
                matches: [],
                invalid: false,
                parent: null,
                keys: new Set(),
                concepts: new Set(),
            }
            record.parent = record
            nodes.set(node.id, record)
        }
        records.set(diagram, nodes)
    }
    const fail = (record, reason) => {
        if (record.invalid) return
        record.invalid = true
        findings.push({
            severity: "unverifiable",
            attribution: "diagram",
            stage: "3",
            file: record.diagram.file,
            line: record.node.line,
            diagram: record.diagram.id,
            rule: "graph-identity-unresolved",
            message: `${record.diagram.id ?? record.diagram.file} node ${record.node.id}: ${reason}`,
        })
    }
    const rootOf = (record) => {
        while (record.parent !== record) {
            record.parent = record.parent.parent
            record = record.parent
        }
        return record
    }
    const merge = (left, right) => {
        left = rootOf(left)
        right = rootOf(right)
        if (left === right) return
        right.parent = left
        for (const key of right.keys) left.keys.add(key)
        for (const concept of right.concepts) left.concepts.add(concept)
    }
    const named = new Map()
    for (const [diagram, nodes] of records) {
        const references = diagram.refines?.length
            ? diagram.refines.flatMap((id) => byId.get(id) ?? [])
            : anchors.includes(diagram)
              ? []
              : anchors
        for (const record of nodes.values()) {
            if (record.local) {
                record.keys.add(`local:${record.scope}`)
                continue
            }
            for (const reference of references) {
                if (reference === diagram) continue
                const match = resolveArchitectureNode(record.node, reference, diagram)
                if (match.candidates?.length > 1) fail(record, "ambiguous node in a parent diagram")
                const target = match.node && records.get(reference)?.get(match.node.id)
                if (target && !target.local) record.matches.push(target)
            }
            if (record.matches.length > 0) continue
            const key = canonicalNodeKey(diagram, record.node.id)
            record.keys.add(key)
            const concept = normalizeArchitectureIdentity(diagram.concepts.get(record.node.id))
            if (concept) record.concepts.add(concept)
            if (named.has(key)) merge(named.get(key), record)
            else named.set(key, record)
        }
    }
    const ordered = [...records.values()]
        .flatMap((nodes) => [...nodes.values()])
        .sort((left, right) => Number(left.diagram.layer?.slice(1) ?? 0) - Number(right.diagram.layer?.slice(1) ?? 0))
    for (const record of ordered) {
        if (record.local || record.invalid || record.matches.length === 0) continue
        const concepts = new Set(record.matches.flatMap((match) => [...rootOf(match).concepts]))
        if (concepts.size > 1 || record.matches.some((match) => match.invalid)) {
            fail(record, "parents declare different or unresolved authorities")
            continue
        }
        // One explicitly anchored node can join differently labelled views of
        // the same boundary, but cannot merge two distinct declared authorities.
        for (const match of record.matches) merge(record, match)
    }
    const keyOf = (diagram, nodeId) => {
        const record = records.get(diagram)?.get(nodeId)
        if (!record || record.invalid) return null
        const root = rootOf(record)
        if (root.keys.size === 0) {
            fail(record, "refinement has no rooted identity")
            return null
        }
        return [...root.keys].sort()[0]
    }
    return { keyOf, findings }
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
