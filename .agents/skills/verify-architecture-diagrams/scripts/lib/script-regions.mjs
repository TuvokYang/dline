// Exact, case-sensitive AST regions. Resolving a scope never proves its runtime behaviour.
import { scriptField as field, scriptName as nameOf, walkScript } from "./script-model.mjs"
import { localBinding } from "./script-scopes.mjs"
import { scriptString } from "./script-values.mjs"

const declarations = new Set([
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "function_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "variable_declarator",
])
const normalizePath = (value) =>
    String(value ?? "")
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
export const regionContains = (region, node) => region.start <= node.start && node.end <= region.end

function topDeclarations(root) {
    const result = []
    const visit = (node) => {
        if (declarations.has(node.type)) result.push(node)
        else if (
            ["program", "export_statement", "lexical_declaration", "variable_declaration", "ambient_declaration"].includes(
                node.type,
            )
        ) {
            for (const child of node.children) visit(child)
        }
    }
    if (root) visit(root)
    return result
}

function members(node) {
    const body = field(node, "body") ?? field(node, "value")
    return ["class_body", "interface_body", "object_type", "object", "enum_body"].includes(body?.type) ? body.children : []
}

function symbolNodes(root, symbol) {
    const parts = typeof symbol === "string" ? symbol.split(".") : []
    if (!parts.length || parts.some((part) => !part || part.trim() !== part)) return []
    let matches = topDeclarations(root).filter((node) => nameOf(node) === parts[0])
    for (const member of parts.slice(1)) {
        matches = matches.flatMap(members).filter((node) => (nameOf(node) ?? field(node, "key")?.text) === member)
    }
    return matches
}

export function resolveScriptRegion(root, selector) {
    if (
        !root ||
        !selector ||
        typeof selector !== "object" ||
        Array.isArray(selector) ||
        Object.keys(selector).some((key) => key !== "symbol") ||
        typeof selector.symbol !== "string" ||
        !selector.symbol
    ) {
        return { state: "unverifiable", reason: "a diagram binding needs one exact source symbol" }
    }
    const matches = symbolNodes(root, selector.symbol)
    if (matches.length !== 1) return { state: "unverifiable", reason: "diagram symbol is missing or ambiguous" }
    const node = matches[0]
    return { state: "resolved", node, start: node.start, end: node.end, line: node.line }
}

export function importsInScriptRegions(snapshot, file, regions) {
    const root = snapshot.scriptModels?.get(file)
    if (!root) return []
    const entries = [...walkScript(root)]
    return snapshot.imports
        .filter((edge) => normalizePath(edge.importer) === normalizePath(file))
        .flatMap((edge) => {
            const statement = root.children.find(
                (node) =>
                    node.type === "import_statement" &&
                    node.line === edge.line &&
                    scriptString(field(node, "source")) === edge.specifier,
            )
            if (!statement) {
                // Re-exports and unmodelled import forms must not disappear just
                // because their binding projection is not supported yet.
                return [edge]
            }
            if (!edge.bindings?.length) return [edge] // Module initialization has no lexical use site.
            const selected = edge.bindings.filter((binding) =>
                entries.some(({ node, ancestors }) => {
                    if (!regions.some((region) => regionContains(region, node))) return false
                    if (
                        !["identifier", "type_identifier", "shorthand_property_identifier"].includes(node.type) ||
                        node.text !== binding.local
                    )
                        return false
                    if (ancestors.includes(statement)) return true
                    return !localBinding(binding.local, ancestors)
                }),
            )
            return selected.length
                ? [{ ...edge, bindings: selected, typeOnly: selected.every((binding) => binding.typeOnly) || edge.typeOnly }]
                : []
        })
}
