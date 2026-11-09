// Shared lexical binding rules for bounded script proofs, not a text-name index.
import { scriptField as field, scriptName as nameOf, walkScript } from "./script-model.mjs"

export const scriptFunctionTypes = new Set(["function_declaration", "function_expression", "arrow_function", "method_definition"])
export const scriptParameters = (node) =>
    field(node, "parameters")?.children ?? (field(node, "parameter") ? [field(node, "parameter")] : [])
export const parameterPattern = (parameter) =>
    ["identifier", "object_pattern", "array_pattern"].includes(parameter?.type)
        ? parameter
        : (field(parameter, "pattern") ?? field(parameter, "name"))
const AMBIGUOUS_BINDING = Object.freeze({ type: "unresolved_binding", children: [], fields: {} })

export function declaredNames(root) {
    return [...walkScript(root)].flatMap(({ node }) =>
        ["identifier", "shorthand_property_identifier_pattern"].includes(node.type) ? [node.text] : [],
    )
}

export function localBinding(name, ancestors) {
    for (let index = ancestors.length - 1; index >= 0; index--) {
        const scope = ancestors[index]
        if (scriptFunctionTypes.has(scope.type)) {
            const parameter = scriptParameters(scope).find((entry) => declaredNames(parameterPattern(entry)).includes(name))
            if (parameter) return { node: parameter, ancestors: ancestors.slice(0, index + 1) }
        }
        if (scope.type === "catch_clause" && declaredNames(field(scope, "parameter")).includes(name))
            return { node: field(scope, "parameter"), ancestors: ancestors.slice(0, index + 1) }
        if (!["program", "statement_block", "for_statement", "for_in_statement", "catch_clause"].includes(scope.type)) continue
        const declarations = []
        const visit = (node, parents) => {
            if (
                node !== scope &&
                (scriptFunctionTypes.has(node.type) || ["class_declaration", "statement_block"].includes(node.type))
            ) {
                if (nameOf(node) === name) declarations.push({ node, ancestors: parents })
                return
            }
            if (node.type === "variable_declarator" && declaredNames(field(node, "name")).includes(name))
                declarations.push({ node, ancestors: parents })
            for (const child of node.children) visit(child, [...parents, node])
        }
        visit(scope, ancestors.slice(0, index))
        if (declarations.length)
            return declarations.length === 1
                ? declarations[0]
                : { node: AMBIGUOUS_BINDING, ancestors: ancestors.slice(0, index + 1) }
    }
    return null
}

export function writesBinding(scope, identifier, binding) {
    return [...walkScript(scope)].some(({ node, ancestors }) => {
        if (!["assignment_expression", "augmented_assignment_expression", "update_expression"].includes(node.type)) return false
        let target = field(node, "left") ?? field(node, "argument")
        while (["member_expression", "subscript_expression"].includes(target?.type)) target = field(target, "object")
        return (
            target?.type === "identifier" && target.text === identifier && localBinding(identifier, ancestors)?.node === binding
        )
    })
}
