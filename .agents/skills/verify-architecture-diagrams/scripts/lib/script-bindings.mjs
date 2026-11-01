// Binding identities supplement language-neutral captures, never runtime delivery evidence.
// All inputs come from syntax nodes while the Skill-local parser is alive.

import { createScriptExportResolver } from "./script-exports.mjs"

const SCRIPT_LANGUAGES = new Set(["typescript", "tsx", "javascript"])
const DECLARATIONS = new Set([
    "class_declaration",
    "abstract_class_declaration",
    "function_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
])
const children = (node) => node?.namedChildren ?? []
const field = (node, name) => node?.childForFieldName(name)
const hasToken = (node, token) => (node?.children ?? []).some((child) => child.type === token)
const nameOf = (node) => field(node, "name")?.text ?? null
const sourceOf = (node) => {
    const source = field(node, "source")
    return source?.type === "string" ? source.text.slice(1, -1) : null
}

export function extractScriptBindings(root, language) {
    if (!SCRIPT_LANGUAGES.has(language)) return null
    const imports = []
    const exports = []
    const declarations = []
    const members = []
    const declare = (node, exported) => {
        if (DECLARATIONS.has(node.type)) {
            const name = nameOf(node)
            if (name) {
                declarations.push({ name, kind: node.type })
                if (exported) exports.push({ name, local: name, source: null })
                if (["class_declaration", "abstract_class_declaration"].includes(node.type)) {
                    for (const member of children(field(node, "body"))) {
                        const memberName = field(member, "name")
                        if (
                            ["method_definition", "public_field_definition"].includes(member.type) &&
                            memberName?.type === "property_identifier"
                        ) {
                            members.push({ name: `${name}.${memberName.text}`, node: memberName })
                        }
                    }
                }
            }
        }
        if (["lexical_declaration", "variable_declaration"].includes(node.type)) {
            for (const variable of children(node).filter((child) => child.type === "variable_declarator")) {
                const name = nameOf(variable)
                if (field(variable, "name")?.type !== "identifier") continue
                declarations.push({ name, kind: "variable_declarator" })
                if (exported) exports.push({ name, local: name, source: null })
            }
        }
    }
    for (const node of children(root)) {
        if (node.type === "import_statement") {
            const source = sourceOf(node)
            const clause = children(node).find((child) => child.type === "import_clause")
            const typeOnly = hasToken(node, "type")
            const bindings = []
            for (const child of children(clause)) {
                if (child.type === "identifier") bindings.push({ local: child.text, imported: "default", typeOnly })
                if (child.type === "namespace_import")
                    bindings.push({ local: children(child).at(-1)?.text, imported: "*", typeOnly })
                if (child.type === "named_imports") {
                    for (const binding of children(child)) {
                        const imported = nameOf(binding)
                        bindings.push({
                            local: field(binding, "alias")?.text ?? imported,
                            imported,
                            typeOnly: typeOnly || hasToken(binding, "type"),
                        })
                    }
                }
            }
            imports.push({ source, bindings, typeOnly, line: node.startPosition.row + 1 })
        } else if (node.type === "export_statement") {
            const source = sourceOf(node)
            const clause = children(node).find((child) => child.type === "export_clause")
            if (clause) {
                for (const binding of children(clause)) {
                    exports.push({
                        name: field(binding, "alias")?.text ?? nameOf(binding),
                        local: nameOf(binding),
                        source,
                        typeOnly: hasToken(node, "type") || hasToken(binding, "type"),
                    })
                }
            } else if (source && (hasToken(node, "*") || children(node).some((child) => child.type === "namespace_export"))) {
                const namespace = children(node).find((child) => child.type === "namespace_export")
                exports.push({
                    name: namespace ? children(namespace)[0]?.text : "*",
                    local: "*",
                    source,
                    namespace: Boolean(namespace),
                    typeOnly: hasToken(node, "type"),
                })
            } else {
                const declaration =
                    field(node, "declaration") ??
                    children(node).find((child) => DECLARATIONS.has(child.type) || child.type === "lexical_declaration")
                if (declaration) {
                    declare(declaration, !hasToken(node, "default"))
                    if (hasToken(node, "default") && nameOf(declaration))
                        exports.push({ name: "default", local: nameOf(declaration), source: null })
                }
            }
        } else declare(node, false)
    }
    return { imports, exports, declarations, members }
}

/** Resolve the exact imported name. Incomplete, cyclic or ambiguous barrels stay unknown. */
export function attachBindingProvenance(imports, modules) {
    const resolve = createScriptExportResolver(imports, modules)
    return imports.map((edge) => {
        const declaration = modules
            .get(edge.importer)
            ?.imports.find((entry) => entry.source === edge.specifier && entry.line === edge.line)
        return Object.freeze({
            ...edge,
            bindings: Object.freeze(
                (declaration?.bindings ?? []).map((binding) =>
                    Object.freeze({
                        ...binding,
                        provenance: Object.freeze(
                            edge.target.kind === "workspace" && binding.imported !== "*"
                                ? resolve(edge.target.path, binding.imported)
                                : { state: edge.target.kind === "workspace" ? "namespace" : "unresolved", declarations: [] },
                        ),
                        valueProvenance: Object.freeze(
                            edge.target.kind === "workspace" && !binding.typeOnly && binding.imported !== "*"
                                ? resolve(edge.target.path, binding.imported, { runtime: true })
                                : { state: binding.typeOnly ? "type-only" : "unresolved", declarations: [] },
                        ),
                    }),
                ),
            ),
        })
    })
}
