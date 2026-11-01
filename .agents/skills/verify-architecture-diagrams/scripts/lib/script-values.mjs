// A small static value domain for wiring certificates. Unknown is never a proof.
// No target module is imported or executed; only detached syntax is inspected.

import { resolveScriptImport } from "./script-exports.mjs"
import { scriptField as field, scriptName as nameOf, walkScript } from "./script-model.mjs"
import { localBinding, parameterPattern, scriptFunctionTypes, scriptParameters, writesBinding } from "./script-scopes.mjs"

const UNKNOWN = Object.freeze({ kind: "unknown" })
const literal = (value) => ({ kind: "literal", value })
const valueTypes = new Set(["class_declaration", "abstract_class_declaration", "function_declaration", "variable_declarator"])

export function scriptString(node) {
    if (node?.type !== "string" || node.children.some((child) => child.type !== "string_fragment")) return null
    return node.children.map((child) => child.text).join("")
}

export function createScriptValueResolver(snapshot) {
    const positions = new Map()
    for (const [file, root] of snapshot.scriptModels ?? []) {
        for (const entry of walkScript(root)) positions.set(entry.node, { ...entry, file })
    }
    const point = (node) => positions.get(node)
    const rootFor = (file) => snapshot.scriptModels.get(file)
    const declaration = (file, symbol) => {
        const candidates = [...walkScript(rootFor(file))].filter(
            ({ node, ancestors }) =>
                valueTypes.has(node.type) &&
                nameOf(node) === symbol &&
                !ancestors.some((ancestor) => scriptFunctionTypes.has(ancestor.type) || ancestor.type === "class_body"),
        )
        return candidates.length === 1 ? candidates[0].node : null
    }

    const mutated = (file, name, binding) => {
        const root = rootFor(file)
        const aliases = new Set([binding])
        let changed = true
        while (changed) {
            changed = false
            for (const { node, ancestors } of walkScript(root)) {
                const value = field(node, "value")
                if (node.type !== "variable_declarator" || value?.type !== "identifier" || aliases.has(node)) continue
                if (aliases.has(localBinding(value.text, ancestors)?.node)) {
                    aliases.add(node)
                    changed = true
                }
            }
        }
        return [...aliases].some((alias) => writesBinding(root, alias === binding ? name : nameOf(alias), alias))
    }

    const originValue = (origin, environment, visited) => {
        const node = declaration(origin.path, origin.symbol)
        return node ? evaluate(node, environment, visited) : UNKNOWN
    }
    const property = (object, key, environment, visited) => {
        if (object.kind === "namespace") {
            const members = [...object.members, key]
            const resolved = resolveScriptImport(snapshot, object.file, object.local, members, { runtime: true })
            if (resolved.state === "namespace") return { ...object, members }
            return resolved.state === "resolved" && resolved.declarations.length === 1
                ? originValue(resolved.declarations[0], environment, visited)
                : UNKNOWN
        }
        if (object.kind === "parameter") return { ...object, projection: [...object.projection, key] }
        if (object.kind === "object") {
            const entries = object.node.children
            if (entries.some((entry) => !["pair", "shorthand_property_identifier", "method_definition"].includes(entry.type)))
                return UNKNOWN
            const keys = entries.map((entry) =>
                entry.type === "shorthand_property_identifier"
                    ? entry.text
                    : (nameOf(entry) ?? field(entry, "key")?.text ?? scriptString(field(entry, "key"))),
            )
            if (new Set(keys).size !== keys.length || keys.includes(null)) return UNKNOWN
            const index = keys.indexOf(key)
            if (index < 0) return UNKNOWN
            const entry = entries[index]
            return evaluate(entry.type === "pair" ? field(entry, "value") : entry, environment, visited)
        }
        if (object.kind === "class" || object.kind === "instance") {
            const replaced = [...walkScript(field(object.node, "body"))].some(({ node }) => {
                if (!["assignment_expression", "augmented_assignment_expression", "update_expression"].includes(node.type))
                    return false
                const target = field(node, "left") ?? field(node, "argument")
                if (field(target, "object")?.type !== "this") return false
                const member =
                    target.type === "member_expression" ? field(target, "property")?.text : scriptString(field(target, "index"))
                return member === null || member === undefined || member === key
            })
            if (replaced) return UNKNOWN
            const members =
                field(object.node, "body")?.children.filter(
                    (node) => nameOf(node) === key && node.tokens.includes("static") === (object.kind === "class"),
                ) ?? []
            if (members.length === 1) {
                const member = members[0]
                if (member.type === "method_definition")
                    return { kind: "callable", node: member, receiver: object, ...point(member) }
                return evaluate(field(member, "value"), environment, visited)
            }
            // Constructor parameter properties retain the exact injected argument.
            if (object.kind === "instance") {
                const constructor = field(object.node, "body")?.children.find(
                    (node) => node.type === "method_definition" && nameOf(node) === "constructor",
                )
                const index = scriptParameters(constructor).findIndex(
                    (parameter) =>
                        parameterPattern(parameter)?.text === key &&
                        parameter.tokens.some((token) => ["private", "protected", "public", "readonly"].includes(token)),
                )
                if (index >= 0) return object.arguments[index] ?? UNKNOWN
            }
        }
        return UNKNOWN
    }
    const evaluate = (node, environment = new Map(), visited = new Set()) => {
        const location = point(node)
        if (!node || !location || visited.has(node)) return UNKNOWN
        const next = new Set([...visited, node])
        const { file, ancestors } = location
        if (
            [
                "parenthesized_expression",
                "as_expression",
                "satisfies_expression",
                "non_null_expression",
                "await_expression",
            ].includes(node.type)
        )
            return evaluate(node.children[0], environment, next)
        if (node.type === "string") {
            const text = scriptString(node)
            return text === null ? UNKNOWN : literal(text)
        }
        if (["true", "false"].includes(node.type)) return literal(node.type === "true")
        if (node.type === "number") return literal(Number(node.text))
        if (node.type === "this") return environment.get("this") ?? UNKNOWN
        if (
            ["function_declaration", "class_declaration", "abstract_class_declaration"].includes(node.type) &&
            mutated(file, nameOf(node), node)
        )
            return UNKNOWN
        if (scriptFunctionTypes.has(node.type)) return { kind: "callable", node, ...location }
        if (["class_declaration", "abstract_class_declaration"].includes(node.type)) return { kind: "class", node, ...location }
        if (node.type === "object") return { kind: "object", node, ...location }
        if (node.type === "variable_declarator") {
            if (field(node, "name")?.type !== "identifier" || mutated(file, nameOf(node), node)) return UNKNOWN
            return evaluate(field(node, "value"), environment, next)
        }
        if (["identifier", "shorthand_property_identifier"].includes(node.type)) {
            const binding = localBinding(node.text, ancestors)
            if (binding) {
                if (mutated(file, node.text, binding.node)) return UNKNOWN
                if (environment.has(binding.node)) return environment.get(binding.node)
                if (["required_parameter", "optional_parameter"].includes(binding.node.type))
                    return { kind: "parameter", binding: binding.node, projection: [], file }
                return evaluate(binding.node, environment, next)
            }
            const resolved = resolveScriptImport(snapshot, file, node.text, [], { runtime: true })
            if (resolved.state === "namespace") return { kind: "namespace", file, local: node.text, members: [] }
            return resolved.state === "resolved" && resolved.declarations.length === 1
                ? originValue(resolved.declarations[0], environment, next)
                : UNKNOWN
        }
        if (["member_expression", "subscript_expression"].includes(node.type)) {
            const key =
                node.type === "member_expression"
                    ? field(node, "property")?.text
                    : evaluate(field(node, "index"), environment, next).value
            return typeof key === "string"
                ? property(evaluate(field(node, "object"), environment, next), key, environment, next)
                : UNKNOWN
        }
        if (node.type === "new_expression") {
            const constructor = evaluate(field(node, "constructor"), environment, next)
            if (constructor.kind !== "class" || constructor.node.children.some((child) => child.type === "class_heritage"))
                return UNKNOWN
            const initializer = field(constructor.node, "body")?.children.find(
                (member) => member.type === "method_definition" && nameOf(member) === "constructor",
            )
            if (
                [...walkScript(field(initializer, "body"))].some(
                    ({ node, ancestors }) =>
                        node.type === "return_statement" && !ancestors.some((ancestor) => scriptFunctionTypes.has(ancestor.type)),
                )
            )
                return UNKNOWN
            return {
                ...constructor,
                kind: "instance",
                construction: node,
                arguments: (field(node, "arguments")?.children ?? []).map((argument) => evaluate(argument, environment, next)),
            }
        }
        return UNKNOWN
    }
    return Object.freeze({
        evaluate,
        property: (object, key, environment = new Map()) => property(object, key, environment, new Set()),
        point,
        declaration,
    })
}
