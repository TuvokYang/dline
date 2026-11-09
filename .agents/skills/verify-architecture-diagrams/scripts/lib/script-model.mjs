// Detached syntax nodes: no WASM handles or target module execution survive scanning.
export function detachScriptNode(node) {
    const children = []
    const fields = {}
    for (let index = 0; index < node.childCount; index++) {
        const child = node.child(index)
        if (!child.isNamed) continue
        const detached = detachScriptNode(child)
        children.push(detached)
        const name = node.fieldNameForChild(index)
        if (name) fields[name] = detached
    }
    return Object.freeze({
        type: node.type,
        text: children.length ? null : node.text,
        start: node.startIndex,
        end: node.endIndex,
        line: node.startPosition.row + 1,
        tokens: Object.freeze(node.children.filter((child) => !child.isNamed).map((child) => child.type)),
        children: Object.freeze(children),
        fields: Object.freeze(fields),
    })
}

export function* walkScript(node, ancestors = []) {
    if (!node) return
    yield { node, ancestors }
    for (const child of node.children) yield* walkScript(child, [...ancestors, node])
}

export const scriptField = (node, field) => node?.fields[field] ?? null
export const scriptName = (node) => scriptField(node, "name")?.text ?? null
export const scriptNodes = (node, type) =>
    [...walkScript(node)].filter((entry) => entry.node.type === type).map((entry) => entry.node)
