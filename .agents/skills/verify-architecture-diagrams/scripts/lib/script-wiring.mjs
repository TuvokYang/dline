// Deliberately bounded wiring proofs. A type reference alone never establishes delivery.
// These adapters prove explicit syntax circuits, not branch reachability or product semantics.
import { scriptField as field, scriptName as nameOf, scriptNodes as nodes, walkScript } from "./script-model.mjs"
import {
    directConstructedCall,
    hasEmptyConstructor,
    hasInertModuleInitialization,
    singleReturnedExpression,
} from "./script-proof-subset.mjs"
import {
    scriptFunctionTypes as functions,
    localBinding,
    scriptParameters as parameters,
    parameterPattern as pattern,
    writesBinding as writesReceiver,
} from "./script-scopes.mjs"
import { createScriptValueResolver } from "./script-values.mjs"

const canonical = (value) => value?.normalize("NFKC").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase()
const samePath = (left, right) => canonical(left) === canonical(right)
const result = (adapter, reason) => Object.freeze({ status: "proven", proven: true, adapter, reason })
const modelFor = (snapshot, file) => [...(snapshot.scriptModels ?? [])].find(([key]) => samePath(file, key))?.[1]

function importedOrigin(snapshot, file, name, ancestors = [], { runtime = false } = {}) {
    if (localBinding(name, ancestors)) return null
    const bindings = snapshot.imports
        .filter((edge) => samePath(edge.importer, file))
        .flatMap((edge) =>
            (edge.bindings ?? []).filter(
                (binding) => binding.local === name && (!runtime || (!edge.typeOnly && !binding.typeOnly)),
            ),
        )
    if (bindings.length !== 1) return null
    const origin = runtime ? bindings[0].valueProvenance : bindings[0].provenance
    return origin?.state === "resolved" && origin.declarations.length === 1 ? origin.declarations[0] : null
}

function typeOrigin(snapshot, file, annotation, contract) {
    if (annotation?.type !== "type_annotation" || annotation.children.length !== 1) return false
    const type = annotation.children[0]
    if (type.type !== "type_identifier") return false
    if (samePath(file, contract.path)) return !contract.symbol || type.text === contract.symbol
    const origin = importedOrigin(snapshot, file, type.text)
    return origin && samePath(origin.path, contract.path) && (!contract.symbol || origin.symbol === contract.symbol)
}

function findFunction(root, symbol) {
    const candidates = []
    for (const { node } of walkScript(root)) {
        if (node.type === "function_declaration" && nameOf(node) === symbol) candidates.push(node)
        if (node.type === "variable_declarator" && nameOf(node) === symbol && functions.has(field(node, "value")?.type))
            candidates.push(field(node, "value"))
    }
    return candidates.length === 1 ? candidates[0] : null
}

function callableValue(value, root, snapshot, file, ancestors) {
    if (!value) return false
    if (functions.has(value.type)) return true
    if (value.type === "jsx_expression" && value.children.length === 1)
        return callableValue(value.children[0], root, snapshot, file, ancestors)
    if (value.type !== "identifier") return false
    const binding = localBinding(value.text, ancestors)
    if (binding) {
        const callable = binding.node.type === "variable_declarator" ? field(binding.node, "value") : binding.node
        return functions.has(callable?.type) && !writesReceiver(root, value.text, binding.node)
    }
    const origin = importedOrigin(snapshot, file, value.text, ancestors, { runtime: true })
    const originRoot = origin && modelFor(snapshot, origin.path)
    const callable = originRoot && findFunction(originRoot, origin.symbol)
    if (!callable) return false
    const declaration = [...walkScript(originRoot)].find(
        ({ node }) => node === callable || field(node, "value") === callable,
    )?.node
    return declaration && !writesReceiver(originRoot, origin.symbol, declaration)
}

function proveJsxProps(edge, snapshot, emitRoot, receiveRoot) {
    const contractRoot = modelFor(snapshot, edge.contract.path)
    const contract = nodes(contractRoot, "interface_declaration").filter(
        (node) => !edge.contract.symbol || nameOf(node) === edge.contract.symbol,
    )
    if (contract.length !== 1 || !samePath(edge.receive.path, edge.contract.path)) return null
    const properties = field(contract[0], "body")?.children ?? []
    if (!properties.length || properties.some((property) => property.type !== "property_signature")) return null
    const exported = (snapshot.scriptModules?.get(edge.emit.path)?.exports ?? [])
        .filter((entry) => entry.local && !entry.source)
        .map((entry) => findFunction(emitRoot, entry.local))
        .filter(Boolean)
    const emitScope = edge.emit.symbol ? findFunction(emitRoot, edge.emit.symbol) : exported.length === 1 ? exported[0] : null
    const rendered = emitScope && singleReturnedExpression(emitScope)
    if (
        !rendered ||
        !["jsx_element", "jsx_self_closing_element"].includes(rendered.type) ||
        !hasInertModuleInitialization(snapshot)
    )
        return null
    const mountAncestors = [...walkScript(emitRoot)].find(({ node }) => node === rendered)?.ancestors ?? []
    for (const { node, ancestors } of walkScript(rendered, mountAncestors)) {
        if (!["jsx_self_closing_element", "jsx_opening_element"].includes(node.type)) continue
        const component = field(node, "name")
        if (component?.type !== "identifier") continue
        const origin = importedOrigin(snapshot, edge.emit.path, component.text, ancestors, { runtime: true })
        if (
            !origin ||
            !samePath(origin.path, edge.receive.path) ||
            (edge.receive.symbol && origin.symbol !== edge.receive.symbol)
        )
            continue
        const receiver = findFunction(receiveRoot, origin.symbol)
        const receiverRender = receiver && singleReturnedExpression(receiver)
        if (
            !receiverRender ||
            !["jsx_element", "jsx_self_closing_element"].includes(receiverRender.type) ||
            parameters(receiver).length !== 1
        )
            continue
        const parameter = parameters(receiver)[0]
        if (!typeOrigin(snapshot, edge.receive.path, field(parameter, "type"), edge.contract)) continue
        const destructuring = pattern(parameter)
        if (
            destructuring?.type !== "object_pattern" ||
            destructuring.children.some((child) => child.type !== "shorthand_property_identifier_pattern")
        )
            continue
        const attributes = node.children.filter((child) => child.type === "jsx_attribute")
        if (node.children.some((child) => child.type === "jsx_expression")) continue // Spread cannot prove which value wins.
        const supplied = new Map(attributes.map((attribute) => [attribute.children[0]?.text, attribute.children[1]]))
        if (supplied.size !== attributes.length) continue
        const receiverAncestors = [...walkScript(receiveRoot)].find(({ node }) => node === receiverRender)?.ancestors ?? []
        const uses = [...walkScript(receiverRender, receiverAncestors)]
        const consumedNames = new Set(
            uses
                .filter(
                    ({ node, ancestors }) =>
                        ["identifier", "shorthand_property_identifier"].includes(node.type) &&
                        localBinding(node.text, ancestors)?.node === parameter,
                )
                .map(({ node }) => node.text),
        )
        const callbackCalls = uses
            .filter(({ node, ancestors }) => {
                const callee = field(node, "function")
                const callback = [...ancestors].reverse().find((ancestor) => functions.has(ancestor.type))
                const attribute = [...ancestors].reverse().find((ancestor) => ancestor.type === "jsx_attribute")
                const element = [...ancestors]
                    .reverse()
                    .find((ancestor) => ["jsx_opening_element", "jsx_self_closing_element"].includes(ancestor.type))
                const eventName = attribute?.children[0]?.text
                const intrinsic = field(element, "name")?.text
                return (
                    node.type === "call_expression" &&
                    callee?.type === "identifier" &&
                    localBinding(callee.text, ancestors)?.node === parameter &&
                    callback &&
                    singleReturnedExpression(callback) === node &&
                    attribute?.children[1]?.children[0] === callback &&
                    /^[a-z]/.test(intrinsic ?? "") &&
                    ["onClick", "onChange", "onInput", "onSubmit"].includes(eventName)
                )
            })
            .map(({ node }) => field(node, "function").text)
        const connected = properties.every((property) => {
            const name = nameOf(property)
            if (property.tokens.includes("?")) return true
            const value = supplied.get(name)
            if (
                !value ||
                !destructuring.children.some((child) => child.text === name) ||
                !consumedNames.has(name) ||
                writesReceiver(receiver, name, parameter)
            )
                return false
            const type = field(property, "type")?.children[0]
            return (
                type?.type !== "function_type" ||
                (callableValue(value, emitRoot, snapshot, edge.emit.path, ancestors) && callbackCalls.includes(name))
            )
        })
        if (connected)
            return result(
                "typescript-jsx-props",
                `component binding, required props and callback consumption connect ${edge.emit.path}:${node.line} to ${edge.receive.path}:${receiver.line}`,
            )
    }
    return null
}

function proveConstructedEvent(edge, snapshot) {
    if (!edge.emit.symbol || !snapshot.scriptModules || !hasInertModuleInitialization(snapshot)) return null
    const values = createScriptValueResolver(snapshot)
    const entry = values.evaluate(values.declaration(edge.emit.path, edge.emit.symbol))
    if (entry.kind !== "callable") return null
    const direct = directConstructedCall(entry.node)
    if (!direct) return null
    const receiver = values.evaluate(direct.construction)
    if (receiver.kind !== "instance" || !samePath(receiver.file, edge.receive.path) || !hasEmptyConstructor(receiver.node))
        return null
    if (edge.receive.symbol && nameOf(receiver.node) !== edge.receive.symbol) return null
    const callee = field(direct.call, "function")
    const method = values.property(receiver, field(callee, "property")?.text)
    if (method.kind !== "callable" || method.node.children.some((child) => child.type === "type_parameters")) return null
    const sent = field(direct.call, "arguments").children[0]
    const binding = localBinding(sent.text, values.point(sent).ancestors)?.node
    if (!parameters(entry.node).includes(binding)) return null
    if (!typeOrigin(snapshot, entry.file, field(binding, "type"), edge.contract)) return null
    if (!typeOrigin(snapshot, method.file, field(parameters(method.node)[0], "type"), edge.contract)) return null
    return result(
        "typescript-constructed-event",
        `straight-line construction and typed call connect ${entry.file}:${direct.call.line} to ${method.file}:${method.node.line}`,
    )
}

export function proveScriptWiring(edge, snapshot) {
    if (!edge.contract?.path) return null
    const emitRoot = modelFor(snapshot, edge.emit.path)
    const receiveRoot = modelFor(snapshot, edge.receive.path)
    if (!emitRoot || !receiveRoot) return null
    if (edge.kind === "injected_port") return proveJsxProps(edge, snapshot, emitRoot, receiveRoot)
    if (edge.kind === "event") return proveConstructedEvent(edge, snapshot)
    return null
}
