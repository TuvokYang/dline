// Diagnostic call exploration over the bounded value domain, not a delivery proof.
// Completion, path feasibility, settlement and heap effects are not fully modelled.
// A certificate adapter must not consume this may-call result as runtime delivery.
import { scriptField as field } from "./script-model.mjs"
import { localBinding, scriptParameters } from "./script-scopes.mjs"

const UNKNOWN = Object.freeze({ kind: "unknown" })
const literal = (value) => ({ kind: "literal", value })
const TERMINAL = new Set(["return_statement", "throw_statement"])

export function traceScriptCalls(entry, values, snapshot, { arguments: arguments_ = [], maxSteps = 512, maxDepth = 24 } = {}) {
    const calls = []
    let steps = 0
    let exhausted = false
    const active = new Set()
    const spend = (depth) => {
        if (++steps > maxSteps || depth > maxDepth) {
            exhausted = true
            return false
        }
        return true
    }
    const isGlobal = (node, name) => {
        const point = values.point(node)
        return (
            node?.type === "identifier" &&
            node.text === name &&
            point &&
            !localBinding(name, point.ancestors) &&
            !(snapshot.scriptModules?.get(point.file)?.imports ?? []).some((entry) =>
                entry.bindings.some((binding) => binding.local === name),
            )
        )
    }
    const invoke = (callable, args, environment, depth) => {
        if (callable.kind !== "callable" || !spend(depth)) return UNKNOWN
        if (active.has(callable.node)) {
            exhausted = true
            return UNKNOWN
        }
        active.add(callable.node)
        const scope = new Map(environment)
        scriptParameters(callable.node).forEach((parameter, index) => scope.set(parameter, args[index] ?? UNKNOWN))
        if (callable.receiver) scope.set("this", callable.receiver)
        const body = field(callable.node, "body")
        let result
        if (body?.type === "statement_block") result = statements(body.children, scope, depth + 1).value
        else result = expression(body, scope, depth + 1)
        active.delete(callable.node)
        return result ?? UNKNOWN
    }
    const expression = (node, environment, depth) => {
        if (!node || !spend(depth)) return UNKNOWN
        if (
            [
                "await_expression",
                "parenthesized_expression",
                "as_expression",
                "satisfies_expression",
                "non_null_expression",
            ].includes(node.type)
        )
            return expression(node.children[0], environment, depth + 1)
        if (node.type === "new_expression" && isGlobal(field(node, "constructor"), "Promise")) {
            const executor = field(node, "arguments")?.children[0]
            invoke(values.evaluate(executor, environment), [], environment, depth + 1)
            return { kind: "promise" }
        }
        if (node.type === "call_expression") {
            const calleeNode = field(node, "function")
            const objectNode = field(calleeNode, "object")
            const property = field(calleeNode, "property")?.text
            const args = (field(node, "arguments")?.children ?? []).map((argument) =>
                expression(argument, environment, depth + 1),
            )
            if (
                calleeNode?.type === "member_expression" &&
                isGlobal(objectNode, "Promise") &&
                ["allSettled", "resolve"].includes(property)
            )
                return { kind: "promise" }
            if (calleeNode?.type === "member_expression" && property === "then") {
                const promise = expression(objectNode, environment, depth + 1)
                if (promise.kind === "promise") {
                    invoke(args[0] ?? UNKNOWN, [], environment, depth + 1)
                    return promise
                }
            }
            const callee = values.evaluate(calleeNode, environment)
            calls.push({ node, callee, arguments: args, environment: new Map(environment), ...values.point(node) })
            return invoke(callee, args, environment, depth + 1)
        }
        if (node.type === "binary_expression") {
            const left = expression(field(node, "left"), environment, depth + 1)
            const operator = node.tokens.find((token) => ["===", "!==", "==", "!=", "&&", "||"].includes(token))
            if (left.kind === "literal" && ((operator === "&&" && !left.value) || (operator === "||" && left.value))) return left
            const right = expression(field(node, "right"), environment, depth + 1)
            if (left.kind === "literal" && right.kind === "literal") {
                if (["===", "=="].includes(operator)) return literal(left.value === right.value)
                if (["!==", "!="].includes(operator)) return literal(left.value !== right.value)
                if (operator === "&&") return literal(left.value && right.value)
                if (operator === "||") return literal(left.value || right.value)
            }
            return UNKNOWN
        }
        if (node.type === "unary_expression" && node.tokens.includes("!")) {
            const operand = expression(field(node, "argument"), environment, depth + 1)
            return operand.kind === "literal" ? literal(!operand.value) : UNKNOWN
        }
        return values.evaluate(node, environment)
    }
    const statement = (node, environment, depth) => {
        if (!spend(depth)) return { terminal: true, value: UNKNOWN }
        if (node.type === "statement_block") return statements(node.children, environment, depth + 1)
        if (TERMINAL.has(node.type))
            return {
                terminal: true,
                value: node.type === "return_statement" ? expression(node.children[0], environment, depth + 1) : UNKNOWN,
            }
        if (["lexical_declaration", "variable_declaration"].includes(node.type)) {
            for (const variable of node.children.filter((child) => child.type === "variable_declarator"))
                environment.set(variable, expression(field(variable, "value"), environment, depth + 1))
        } else if (node.type === "expression_statement") expression(node.children[0], environment, depth + 1)
        else if (node.type === "if_statement") {
            const condition = expression(field(node, "condition"), environment, depth + 1)
            const consequence = field(node, "consequence")
            const alternative = field(node, "alternative")
            if (condition.kind === "literal") {
                const selected = condition.value ? consequence : alternative
                return selected
                    ? statement(selected.type === "else_clause" ? selected.children[0] : selected, environment, depth + 1)
                    : { terminal: false }
            }
            const yes = statement(consequence, new Map(environment), depth + 1)
            const no = alternative
                ? statement(
                      alternative.type === "else_clause" ? alternative.children[0] : alternative,
                      new Map(environment),
                      depth + 1,
                  )
                : { terminal: false }
            return { terminal: yes.terminal && no.terminal, value: UNKNOWN }
        } else if (node.type === "try_statement") {
            // The try body is the direct circuit; a catch is not assumed to run.
            return statement(field(node, "body"), environment, depth + 1)
        }
        // Loops and callback registration are not evidence that a nested body executes.
        return { terminal: false }
    }
    const statements = (nodes, environment, depth) => {
        for (const node of nodes) {
            const result = statement(node, environment, depth)
            if (result.terminal) return result
        }
        return { terminal: false, value: UNKNOWN }
    }
    const returned = invoke(entry, arguments_, new Map(), 0)
    return Object.freeze({ calls: Object.freeze(calls), returned, exhausted, steps, proofEligible: false })
}
