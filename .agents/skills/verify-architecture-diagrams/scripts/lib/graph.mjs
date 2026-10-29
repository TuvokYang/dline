// Pure graph algorithms over parsed diagram nodes and edges.

export function solidEdges(diagram) {
    return diagram.edges.filter((edge) => edge.style === "solid")
}

export function dottedEdges(diagram) {
    return diagram.edges.filter((edge) => edge.style === "dotted")
}

export function adjacency(edges, pick = (edge) => edge.from) {
    const map = new Map()
    for (const edge of edges) {
        const from = pick(edge)
        if (!map.has(from)) map.set(from, [])
        map.get(from).push(edge)
    }
    return map
}

// Tarjan strongly connected components, iterative to stay safe on large graphs.
export function stronglyConnectedComponents(nodeIds, edges) {
    const outgoing = new Map(nodeIds.map((id) => [id, []]))
    for (const edge of edges) {
        if (!outgoing.has(edge.from) || !outgoing.has(edge.to)) continue
        outgoing.get(edge.from).push(edge.to)
    }

    let counter = 0
    const index = new Map()
    const low = new Map()
    const stack = []
    const onStack = new Set()
    const components = []

    for (const root of nodeIds) {
        if (index.has(root)) continue
        const work = [{ node: root, next: 0 }]
        index.set(root, counter)
        low.set(root, counter)
        counter += 1
        stack.push(root)
        onStack.add(root)

        while (work.length > 0) {
            const frame = work.at(-1)
            const children = outgoing.get(frame.node) ?? []
            if (frame.next < children.length) {
                const child = children[frame.next]
                frame.next += 1
                if (!index.has(child)) {
                    index.set(child, counter)
                    low.set(child, counter)
                    counter += 1
                    stack.push(child)
                    onStack.add(child)
                    work.push({ node: child, next: 0 })
                } else if (onStack.has(child)) {
                    low.set(frame.node, Math.min(low.get(frame.node), index.get(child)))
                }
                continue
            }
            work.pop()
            const parent = work.at(-1)
            if (parent) low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)))
            if (low.get(frame.node) === index.get(frame.node)) {
                const component = []
                for (;;) {
                    const member = stack.pop()
                    onStack.delete(member)
                    component.push(member)
                    if (member === frame.node) break
                }
                components.push(component)
            }
        }
    }
    return components
}

export function findCycles(nodeIds, edges) {
    const selfLoops = edges.filter((edge) => edge.from === edge.to)
    const components = stronglyConnectedComponents(nodeIds, edges).filter(
        (component) => component.length > 1 || selfLoops.some((edge) => component.includes(edge.from)),
    )
    return { components, selfLoops }
}

// Shortest cycle path inside one strongly connected component, for readable reports.
export function cyclePath(component, edges) {
    const members = new Set(component)
    const outgoing = adjacency(edges.filter((edge) => members.has(edge.from) && members.has(edge.to)))
    const start = [...members].sort()[0]

    let best = null
    for (const first of outgoing.get(start) ?? []) {
        if (first.to === start) return [start, start]
        const queue = [[first.to, [start, first.to]]]
        const seen = new Set([start, first.to])
        while (queue.length > 0) {
            const [node, path] = queue.shift()
            if (path.length > members.size + 1) break
            for (const edge of outgoing.get(node) ?? []) {
                if (edge.to === start) {
                    const cycle = [...path, start]
                    if (!best || cycle.length < best.length) best = cycle
                    continue
                }
                if (seen.has(edge.to)) continue
                seen.add(edge.to)
                queue.push([edge.to, [...path, edge.to]])
            }
        }
        if (best && best.length === 2) break
    }
    return best ?? component
}

// Kahn topological order; returns the order plus any nodes that could not be ordered.
export function topologicalOrder(nodeIds, edges) {
    const indegree = new Map(nodeIds.map((id) => [id, 0]))
    const outgoing = new Map(nodeIds.map((id) => [id, []]))
    for (const edge of edges) {
        if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue
        if (edge.from === edge.to) continue
        outgoing.get(edge.from).push(edge.to)
        indegree.set(edge.to, indegree.get(edge.to) + 1)
    }
    const ready = nodeIds.filter((id) => indegree.get(id) === 0).sort()
    const order = []
    while (ready.length > 0) {
        const node = ready.shift()
        order.push(node)
        for (const next of outgoing.get(node) ?? []) {
            indegree.set(next, indegree.get(next) - 1)
            if (indegree.get(next) === 0) ready.push(next)
        }
        ready.sort()
    }
    return { order, unordered: nodeIds.filter((id) => !order.includes(id)) }
}

export function subgraphOf(diagram, subgraphId) {
    const byId = new Map(diagram.subgraphs.map((subgraph) => [subgraph.id, subgraph]))
    return byId.get(subgraphId) ?? null
}

// Innermost subgraph for a node plus its ancestor chain, outermost first.
export function subgraphChain(diagram, node) {
    const byId = new Map(diagram.subgraphs.map((subgraph) => [subgraph.id, subgraph]))
    const chain = []
    let current = node.subgraph ? byId.get(node.subgraph) : null
    const guard = new Set()
    while (current && !guard.has(current.id)) {
        guard.add(current.id)
        chain.unshift(current)
        current = current.parent ? byId.get(current.parent) : null
    }
    return chain
}

export function nodeLabel(diagram, nodeId) {
    return diagram.nodes.get(nodeId)?.label ?? null
}
