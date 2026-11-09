// Exact module/member provenance. Type-space visibility never grants value-space access.
const valueDeclarations = new Set([
    "class_declaration",
    "abstract_class_declaration",
    "function_declaration",
    "variable_declarator",
    "enum_declaration",
])
const unknown = (state) => ({ state, declarations: [] })

export function createScriptExportResolver(imports, modules) {
    const targets = new Map()
    for (const edge of imports) targets.set(`${edge.importer}\0${edge.specifier}`, edge.target)
    const target = (file, source) => targets.get(`${file}\0${source}`)

    const resolve = (file, names, runtime, visited) => {
        if (!names.length) return unknown("namespace")
        const key = `${file}#${names.join(".")}#${runtime}`
        if (visited.has(key)) return unknown("cyclic")
        const module = modules.get(file)
        if (!module) return unknown("unscanned")
        const next = new Set([...visited, key])
        const explicit = module.exports.filter((entry) => entry.name === names[0])
        const candidates = explicit.length
            ? explicit
            : module.exports.filter((entry) => entry.name === "*" && names[0] !== "default")
        if (!candidates.length) return unknown("missing")
        const origins = new Map()
        for (const candidate of candidates) {
            if (runtime && candidate.typeOnly) return unknown("type-only")
            let result
            if (candidate.source) {
                const dependency = target(file, candidate.source)
                if (dependency?.kind !== "workspace") return unknown("unresolved")
                const forwarded = candidate.namespace
                    ? names.slice(1)
                    : candidate.name === "*"
                      ? names
                      : [candidate.local, ...names.slice(1)]
                result = resolve(dependency.path, forwarded, runtime, next)
            } else {
                const declarations = module.declarations.filter(
                    (entry) => entry.name === candidate.local && (!runtime || valueDeclarations.has(entry.kind)),
                )
                if (declarations.length && names.length === 1) {
                    result = { state: "resolved", declarations: [{ kind: "workspace", path: file, symbol: candidate.local }] }
                } else {
                    const bindings = module.imports.flatMap((entry) =>
                        entry.bindings
                            .filter((binding) => binding.local === candidate.local)
                            .map((binding) => ({ ...binding, source: entry.source })),
                    )
                    if (bindings.length !== 1) return unknown(declarations.length ? "unsupported-member" : "missing")
                    const binding = bindings[0]
                    if (runtime && binding.typeOnly) return unknown("type-only")
                    const dependency = target(file, binding.source)
                    if (dependency?.kind !== "workspace") return unknown("unresolved")
                    result = resolve(
                        dependency.path,
                        binding.imported === "*" ? names.slice(1) : [binding.imported, ...names.slice(1)],
                        runtime,
                        next,
                    )
                }
            }
            if (result.state === "missing" && !explicit.length) continue
            if (result.state !== "resolved") return result
            for (const declaration of result.declarations) origins.set(`${declaration.path}#${declaration.symbol}`, declaration)
        }
        if (origins.size !== 1) return unknown(origins.size > 1 ? "ambiguous" : "missing")
        return { state: "resolved", declarations: [...origins.values()] }
    }
    return (file, names, { runtime = false } = {}) => resolve(file, Array.isArray(names) ? names : [names], runtime, new Set())
}

export function resolveScriptImport(snapshot, file, local, members = [], { runtime = false } = {}) {
    const bindings = (snapshot.scriptModules?.get(file)?.imports ?? []).flatMap((entry) =>
        entry.bindings.filter((binding) => binding.local === local).map((binding) => ({ ...binding, source: entry.source })),
    )
    if (bindings.length !== 1) return unknown("unresolved")
    const binding = bindings[0]
    if (runtime && binding.typeOnly) return unknown("type-only")
    const dependency = snapshot.imports.find((edge) => edge.importer === file && edge.specifier === binding.source)?.target
    if (dependency?.kind !== "workspace") return unknown("unresolved")
    const resolve = createScriptExportResolver(snapshot.imports, snapshot.scriptModules)
    return resolve(dependency.path, binding.imported === "*" ? members : [binding.imported, ...members], { runtime })
}
