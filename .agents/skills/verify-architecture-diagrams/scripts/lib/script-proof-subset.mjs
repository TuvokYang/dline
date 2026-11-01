// Admission to a wiring certificate is narrower than diagnostic value/call exploration.
// Unsupported control, initialization or effects must not be treated as transparent.
import { scriptField as field, scriptName as nameOf } from "./script-model.mjs"
import { scriptFunctionTypes } from "./script-scopes.mjs"

export function unwrapScriptExpression(node) {
    while (["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression"].includes(node?.type))
        node = node.children[0]
    return node
}

const statements = (node) => node?.children.filter((child) => child.type !== "comment") ?? []

export function singleReturnedExpression(fn) {
    const body = field(fn, "body")
    if (body?.type !== "statement_block") return unwrapScriptExpression(body)
    const entries = statements(body)
    return entries.length === 1 && entries[0].type === "return_statement" ? unwrapScriptExpression(entries[0].children[0]) : null
}

function inertValue(node) {
    node = unwrapScriptExpression(node)
    if (!node) return false
    if (scriptFunctionTypes.has(node.type) || ["string", "number", "true", "false", "null"].includes(node.type)) return true
    return false
}

function inertDeclaration(node) {
    if (node.type === "export_statement") {
        const declaration = field(node, "declaration")
        return declaration
            ? inertDeclaration(declaration)
            : node.children.every((child) => ["export_clause", "string", "comment"].includes(child.type))
    }
    if (
        ["import_statement", "interface_declaration", "type_alias_declaration", "function_declaration", "comment"].includes(
            node.type,
        )
    )
        return true
    if (["class_declaration", "abstract_class_declaration"].includes(node.type)) {
        if (node.children.some((child) => child.type === "class_heritage" || child.type === "decorator")) return false
        return statements(field(node, "body")).every(
            (member) => member.type === "method_definition" && field(member, "name")?.type === "property_identifier",
        )
    }
    if (node.type === "lexical_declaration" && node.tokens.includes("const")) {
        return node.children.every(
            (variable) =>
                variable.type === "variable_declarator" &&
                field(variable, "name")?.type === "identifier" &&
                inertValue(field(variable, "value")),
        )
    }
    return false
}

export function hasInertModuleInitialization(snapshot) {
    return (
        snapshot.scriptModels?.size > 0 &&
        [...snapshot.scriptModels.values()].every((root) => root.children.every(inertDeclaration))
    )
}

// This certificate covers a straight-line construction followed by one typed call.
// More general DI, alias/effect and async circuits remain diagnostic until modelled.
export function directConstructedCall(fn) {
    const body = field(fn, "body")
    if (body?.type !== "statement_block" || fn.children.some((child) => child.type === "type_parameters")) return null
    const entries = statements(body)
    if (entries.length !== 2) return null
    const declaration = entries[0]
    if (declaration.type !== "lexical_declaration" || !declaration.tokens.includes("const") || declaration.children.length !== 1)
        return null
    const variable = declaration.children[0]
    const construction = field(variable, "value")
    if (
        variable.type !== "variable_declarator" ||
        field(variable, "name")?.type !== "identifier" ||
        construction?.type !== "new_expression"
    )
        return null
    if (field(construction, "constructor")?.type !== "identifier" || statements(field(construction, "arguments")).length !== 0)
        return null
    if (entries[1].type !== "return_statement") return null
    const call = unwrapScriptExpression(entries[1].children[0])
    const callee = field(call, "function")
    if (call?.type !== "call_expression" || callee?.type !== "member_expression") return null
    if (field(callee, "object")?.type !== "identifier" || field(callee, "object").text !== nameOf(variable)) return null
    const arguments_ = statements(field(call, "arguments"))
    if (arguments_.length !== 1 || arguments_[0].type !== "identifier") return null
    return { call, construction, variable }
}

export function hasEmptyConstructor(receiver) {
    const body = field(receiver, "body")
    const constructor = statements(body).find((member) => nameOf(member) === "constructor")
    return (
        !constructor ||
        (constructor.type === "method_definition" &&
            statements(field(constructor, "parameters")).length === 0 &&
            statements(field(constructor, "body")).length === 0)
    )
}
