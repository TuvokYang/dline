// Resolve RPC message identity against canonical Proto declarations and import
// visibility. A matching short name in another file is not a type certificate.
import path from "node:path"

const unresolved = (reason) => ({ state: "unresolved", reason })

function visibleFiles(file, byPath) {
    const visible = new Set([file.path])
    const visitPublic = (target) => {
        if (!target || visible.has(target)) return
        visible.add(target)
        for (const imported of byPath.get(target)?.imports ?? []) {
            if (imported.visibility === "public") visitPublic(imported.target)
        }
    }
    for (const imported of file.imports) visitPublic(imported.target)
    return visible
}

function typeIdentity(reference, packageName, visible, types, symbols) {
    if (!reference || !/^\.?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(reference)) {
        return unresolved("unsupported type reference")
    }
    let fullName = reference.startsWith(".") ? reference.slice(1) : null
    if (!fullName) {
        const [head] = reference.split(".")
        const scope = packageName ? packageName.split(".") : []
        for (let count = scope.length; count >= 0; count--) {
            const prefix = [...scope.slice(0, count), head].join(".")
            // Bind the first component once. A nearer Outer with no Inner
            // must not fall back to a different package's Outer.Inner.
            if (!symbols.has(prefix)) continue
            fullName = [...scope.slice(0, count), reference].join(".")
            break
        }
    }
    if (!fullName) return unresolved("no visible first namespace component")
    const candidates = types.filter((type) => type.fullName === fullName && visible.has(type.file))
    if (candidates.length > 1) return { state: "ambiguous", fullName, candidates: candidates.map((type) => type.file).sort() }
    const candidate = candidates[0]
    if (candidate?.kind !== "message") return unresolved("no unique visible message declaration")
    return { state: "resolved", fullName: candidate.fullName, file: candidate.file, kind: candidate.kind }
}

export function attachProtoTypeIdentities(files, protoRoot) {
    const byPath = new Map(files.map((file) => [file.path, file]))
    const types = files.flatMap((file) => file.types)
    for (const file of files) {
        for (const imported of file.imports) {
            const target = imported.path && path.posix.join(protoRoot, imported.path)
            imported.target = target && byPath.has(target) ? target : null
        }
    }
    for (const file of files) {
        const visible = visibleFiles(file, byPath)
        const symbols = new Set()
        for (const type of [...types, ...files.flatMap((entry) => entry.services)]) {
            if (!visible.has(type.file)) continue
            const parts = type.fullName.split(".")
            for (let count = 1; count <= parts.length; count++) symbols.add(parts.slice(0, count).join("."))
        }
        for (const service of file.services) {
            for (const method of service.methods) {
                method.requestIdentity = typeIdentity(method.requestType, file.package, visible, types, symbols)
                method.responseIdentity = typeIdentity(method.responseType, file.package, visible, types, symbols)
            }
        }
    }
}
