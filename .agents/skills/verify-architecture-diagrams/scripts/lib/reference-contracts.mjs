// Reference permission is per Task, emitting region and imported binding.
// Flow order, fact edges and read references never grant import permission.
import { effectiveKind } from "./checks-intra.mjs"
import { importsInScriptRegions, resolveScriptRegion } from "./script-regions.mjs"

const canonical = (value) =>
    String(value ?? "")
        .normalize("NFKC")
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
        .replace(/\/+/g, "/")
        .toLowerCase()
const SOURCE_KINDS = new Set(["whole_file", "module", "symbol"])
const denied = () => ({ state: "denied" })
const unproven = (reason) => ({ state: "unverifiable", reason })

export function containsPath(container, candidate) {
    const root = canonical(container).replace(/\/$/, "")
    const file = canonical(candidate)
    return Boolean(root) && (file === root || file.startsWith(`${root}/`))
}

function coversPath(boundary, file) {
    return boundary.kind === "module" ? containsPath(boundary.path, file) : canonical(boundary.path) === canonical(file)
}

export function sameSignal(left, right) {
    return Boolean(left) && left === right
}

// Split before collecting permissions: different declarations can cover separate
// bindings, but one allowed binding can never authorize the others on that line.
export function referenceParts(edge) {
    return edge.bindings?.length ? edge.bindings.map((binding) => ({ ...edge, bindings: [binding] })) : [edge]
}

export function signalState(edge, symbol, { path = edge?.target?.path, runtime = false } = {}) {
    if (!symbol) return { state: "module" }
    const bindings = edge?.bindings ?? []
    if (!bindings.length) return unproven(`module initialization carries no symbol ${symbol}`)
    const declarations = []
    for (const binding of bindings) {
        const provenance = runtime ? binding.valueProvenance : (binding.provenance ?? binding.valueProvenance)
        if (runtime && binding.typeOnly) continue
        if (provenance?.state !== "resolved" || !provenance.declarations?.length) continue
        declarations.push(
            ...provenance.declarations.filter(
                (entry) =>
                    entry.kind === "workspace" && canonical(entry.path) === canonical(path) && sameSignal(entry.symbol, symbol),
            ),
        )
    }
    if (declarations.length) return { state: "resolved", declarations }
    return unproven(`no resolved import identity reaches ${path}#${symbol}`)
}

function artifactCounterpart(from, target, origin) {
    if (!from?.path || !target?.path) return null
    return {
        from: canonical(from.path),
        fromKind: from.symbol ? "symbol" : "module",
        path: canonical(target.path),
        kind: target.symbol ? "symbol" : "module",
        selector: target.symbol ?? null,
        regionSymbol: from.symbol ?? null,
        origin,
    }
}

function evidenceCounterparts(edge) {
    if (["direct_import", "composition"].includes(edge.kind))
        return [artifactCounterpart(edge.emit, edge.receive, `evidence:${edge.id}`)]
    if (["injected_port", "event", "callback"].includes(edge.kind))
        return [artifactCounterpart(edge.emit, edge.contract, `evidence:${edge.id}`)]
    return []
}

function diagramCounterparts(diagram, evidence) {
    if (!diagram || diagram.ignored || effectiveKind(diagram) !== "structure") return []
    const result = []
    const internal = [...diagram.artifacts.values()].flat()
    if (evidence?.diagramId === diagram.id) {
        for (const [nodeId, node] of evidence.nodes ?? []) {
            if (diagram.nodes.has(nodeId)) internal.push(...node.artifacts)
        }
    }
    for (const artifact of internal) result.push(artifactCounterpart(artifact, artifact, "diagram:internal"))
    for (const edge of diagram.edges) {
        if (edge.style !== "solid" || edge.from === edge.to) continue
        for (const from of diagram.artifacts.get(edge.from) ?? []) {
            for (const to of diagram.artifacts.get(edge.to) ?? [])
                result.push(artifactCounterpart(from, to, `diagram:${edge.from}->${edge.to}`))
        }
    }
    return result
}

export function declaredCounterparts(task) {
    return [
        ...(task?.architectureEvidence?.edges ?? []).flatMap(evidenceCounterparts),
        ...(task?.diagrams ?? [])
            .filter((parsed) => !parsed.problems?.length)
            .flatMap((parsed) => diagramCounterparts(parsed.diagram, task.architectureEvidence)),
    ].filter(Boolean)
}

function modelOf(snapshot, file) {
    const entry = [...(snapshot?.scriptModels ?? [])].find(([candidate]) => canonical(candidate) === canonical(file))
    return entry ? { key: entry[0], root: entry[1] } : null
}

function sameReference(candidate, edge) {
    if (
        canonical(candidate.importer) !== canonical(edge.importer) ||
        candidate.line !== edge.line ||
        candidate.specifier !== edge.specifier ||
        canonical(candidate.target?.path) !== canonical(edge.target?.path)
    )
        return false
    return (edge.bindings ?? []).every((binding) =>
        candidate.bindings?.some(
            (other) =>
                other.local === binding.local && other.imported === binding.imported && other.typeOnly === binding.typeOnly,
        ),
    )
}

function regionAllows(declaration, edge, snapshot) {
    const model = modelOf(snapshot, declaration.from)
    const symbol = declaration.regionSymbol
    if (!model) return unproven(`no script model is available for ${declaration.from}#${symbol}`)
    const selected = resolveScriptRegion(model.root, { symbol })
    if (selected.state !== "resolved")
        return unproven(`the declared emitting symbol ${declaration.from}#${symbol} cannot be resolved`)
    if (!edge.bindings?.length) return unproven(`module initialization cannot be assigned to emitting symbol ${symbol}`)
    if (importsInScriptRegions(snapshot, model.key, [selected]).some((candidate) => sameReference(candidate, edge)))
        return { state: "allowed" }
    return { state: "denied", reason: `${symbol} has no modelled use of this imported binding` }
}

function permitsBinding(declaration, edge, snapshot) {
    const direct = coversPath(declaration, edge.target?.path)
    const identity = declaration.kind === "symbol" ? signalState(edge, declaration.selector, { path: declaration.path }) : null
    if (!direct && identity?.state !== "resolved") return denied()
    if (!SOURCE_KINDS.has(declaration.kind)) return unproven(`boundary kind ${declaration.kind} names no source reference`)
    if (identity && identity.state !== "resolved") return identity
    return declaration.regionSymbol ? regionAllows(declaration, edge, snapshot) : { state: "allowed" }
}

export function counterpartAllows(declaration, reference, { codeSnapshot = null } = {}) {
    if (!declaration) return denied()
    const edge = reference.edge ?? { importer: reference.importer, target: { path: reference.target }, bindings: [] }
    if (
        declaration.from !== null &&
        !coversPath({ path: declaration.from, kind: declaration.fromKind }, reference.importer ?? edge.importer)
    )
        return denied()
    const results = referenceParts(edge).map((part) => permitsBinding(declaration, part, codeSnapshot))
    return results.find((result) => result.state !== "allowed") ?? { state: "allowed" }
}
