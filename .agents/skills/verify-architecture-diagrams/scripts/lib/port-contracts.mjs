// Optional black-box port inventories and opaque nominal contracts.
// No code signatures, runtime wiring, or structural/TypeScript type inference.
// This module must not import the Mermaid parser: the parser delegates here.

const NODE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const PORT_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/
const MODES = new Set(["in", "out", "requires", "provides"])
const COMPLETENESS = new Set(["complete", "partial"])
const STYLES = new Set(["solid", "dotted"])
const FIELDS = {
    ports: ["completeness"],
    port: ["mode", "type", "required"],
    "edge-ports": ["from", "to", "style", "label", "from_port", "to_port"],
}

export function createPortContracts() {
    return {
        enabled: false,
        inventories: new Map(), // nodeId -> { nodeId, completeness, line }
        ports: new Map(), // nodeId -> Map(portId -> { nodeId, id, mode, type, required, line })
        // Deferred decorations, NOT connections. Selectors never supply topology:
        // every check resolves them afresh against the actual diagram.edges.
        edgeAnnotations: [], // { selector: { from, to, style, label }, fromPort, toPort, line }
        annotationErrors: [], // { severity, line, rule, message }; projected by checkPortContracts
    }
}

function annotationError(contracts, line, rule, message, severity = "blocking") {
    contracts.annotationErrors.push({ severity, line, rule, message })
}

// Unlike the legacy attribute reader, this consumes the entire input, rejects
// repeated/unknown keys, and never silently discards malformed trailing text.
function readFields(contracts, kind, text, line) {
    const allowed = FIELDS[kind]
    const fields = new Map()
    let rest = text.trim()
    let valid = true
    while (rest.length > 0) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|[^\s"]+)(?=\s|$)/.exec(rest)
        if (!match) {
            annotationError(contracts, line, "port-annotation-syntax", `%% ${kind}: malformed attributes near ${rest}`)
            return null
        }
        const key = match[1]
        const raw = match[2]
        const value = raw.startsWith('"') ? raw.slice(1, -1) : raw
        if (!allowed.includes(key)) {
            annotationError(contracts, line, "port-attribute-unknown", `%% ${kind}: unknown attribute ${key}`)
            valid = false
        }
        if (fields.has(key)) {
            annotationError(contracts, line, "port-attribute-duplicate", `%% ${kind}: repeats attribute ${key}`)
            valid = false
        }
        fields.set(key, value)
        rest = rest.slice(match[0].length).trimStart()
    }
    for (const key of allowed) {
        if (fields.has(key)) continue
        annotationError(contracts, line, "port-attribute-missing", `%% ${kind}: requires ${key}=`)
        valid = false
    }
    return valid ? fields : null
}

function nominalType(type) {
    // An opaque, nonempty identifier, not a TS expression. Punctuation used by
    // qualified/versioned ids is preserved; even case and versions must match.
    return /^[^\s"'`<>{}()[\]|&=,]+$/u.test(type) && !/^(unknown|any)$/i.test(type)
}

/** Consume a port annotation body (without %%); retain errors for the checker. */
export function parsePortAnnotation(diagram, body, line) {
    const text = body.trim()
    const recognized = /^(ports|port|edge-ports)(?=\s|:|$)/i.exec(text)
    if (!recognized) return false
    const contracts = diagram.portContracts ?? (diagram.portContracts = createPortContracts())
    contracts.enabled = true
    const kind = recognized[1].toLowerCase()
    const rest = text.slice(recognized[0].length)
    if (!rest.startsWith(":")) {
        annotationError(contracts, line, "port-annotation-syntax", `%% ${kind}: requires a colon after ${kind}`)
        return true
    }

    let attributes = rest.slice(1).trim()
    let target = null
    if (kind !== "edge-ports") {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(attributes)
        target = match?.[1] ?? ""
        attributes = match?.[2] ?? ""
    }
    const fields = readFields(contracts, kind, attributes, line)
    if (!fields) return true

    if (kind === "ports") {
        if (!NODE_ID.test(target)) {
            annotationError(contracts, line, "port-target-invalid", `%% ports: invalid node id ${target || "(missing)"}`)
        } else if (!COMPLETENESS.has(fields.get("completeness"))) {
            annotationError(contracts, line, "ports-completeness-invalid", "%% ports: completeness must be complete or partial")
        } else if (contracts.inventories.has(target)) {
            annotationError(contracts, line, "ports-duplicate", `%% ports: repeats inventory for ${target}`)
        } else {
            contracts.inventories.set(target, { nodeId: target, completeness: fields.get("completeness"), line })
        }
        return true
    }

    if (kind === "port") {
        // Split at the last dot: Mermaid node ids themselves may contain dots.
        const separator = target.lastIndexOf(".")
        const nodeId = target.slice(0, separator)
        const id = target.slice(separator + 1)
        if (separator < 1 || !NODE_ID.test(nodeId) || !PORT_ID.test(id)) {
            annotationError(contracts, line, "port-target-invalid", `%% port: expected Node.port, got ${target || "(missing)"}`)
            return true
        }
        let valid = true
        const mode = fields.get("mode")
        const type = fields.get("type")
        const required = fields.get("required")
        if (!MODES.has(mode)) {
            annotationError(contracts, line, "port-mode-invalid", `%% port: ${target} mode must be in, out, requires or provides`)
            valid = false
        }
        if (!nominalType(type)) {
            annotationError(
                contracts,
                line,
                "port-type-unverifiable",
                `%% port: ${target} needs a nonempty nominal type id; empty, unknown, any and type expressions prove no contract`,
                "unverifiable",
            )
            valid = false
        }
        if (required !== "true" && required !== "false") {
            annotationError(contracts, line, "port-required-invalid", `%% port: ${target} required must be true or false`)
            valid = false
        }
        if (contracts.ports.get(nodeId)?.has(id)) {
            annotationError(contracts, line, "port-duplicate", `%% port: ${target} is declared more than once`)
            valid = false
        }
        if (valid) {
            if (!contracts.ports.has(nodeId)) contracts.ports.set(nodeId, new Map())
            contracts.ports.get(nodeId).set(id, { nodeId, id, mode, type, required: required === "true", line })
        }
        return true
    }

    const from = fields.get("from")
    const to = fields.get("to")
    const style = fields.get("style")
    const fromPort = fields.get("from_port")
    const toPort = fields.get("to_port")
    let valid = true
    if (!NODE_ID.test(from) || !NODE_ID.test(to) || !PORT_ID.test(fromPort) || !PORT_ID.test(toPort)) {
        annotationError(
            contracts,
            line,
            "port-target-invalid",
            "%% edge-ports: from/to must be node ids and from_port/to_port must be port ids",
        )
        valid = false
    }
    if (!STYLES.has(style)) {
        annotationError(contracts, line, "edge-ports-style-invalid", "%% edge-ports: style must be solid or dotted")
        valid = false
    }
    if (valid) {
        contracts.edgeAnnotations.push({
            selector: { from, to, style, label: fields.get("label") },
            fromPort,
            toPort,
            line,
        })
    }
    return true
}

function finding(diagram, subject, rule, message, severity = "blocking", stage = "2") {
    return {
        severity,
        attribution: "diagram",
        stage,
        file: diagram.file,
        line: subject?.line ?? diagram.line,
        diagram: diagram.id ?? diagram.answers ?? diagram.layer ?? diagram.file,
        rule,
        message,
    }
}

function checkTarget(diagram, subject, nodeId, findings) {
    if (!diagram.nodes.has(nodeId)) {
        findings.push(
            finding(
                diagram,
                subject,
                "port-node-unknown",
                `port annotation names node ${nodeId}, but the diagram does not draw it`,
            ),
        )
        return false
    }
    if (diagram.noteNodes?.has(nodeId)) {
        findings.push(
            finding(diagram, subject, "port-target-invalid", `note node ${nodeId} cannot declare or bind a black-box port`),
        )
        return false
    }
    return true
}

function edgeName(edge) {
    return `${edge.from} -> ${edge.to} style=${edge.style} label=${JSON.stringify(edge.label)}`
}

function resolveDecorations(diagram, contracts, findings) {
    // This map is keyed by original edge objects, not endpoint pairs or a new
    // graph. Duplicate decorators invalidate the decoration, never overwrite it.
    const decorations = new Map()
    for (const annotation of contracts.edgeAnnotations) {
        const selector = annotation.selector
        const validFrom = checkTarget(diagram, annotation, selector.from, findings)
        const validTo = checkTarget(diagram, annotation, selector.to, findings)
        const matches = diagram.edges.filter(
            (edge) =>
                edge.from === selector.from &&
                edge.to === selector.to &&
                edge.style === selector.style &&
                edge.label === selector.label,
        )
        if (matches.length !== 1) {
            findings.push(
                finding(
                    diagram,
                    annotation,
                    matches.length === 0 ? "edge-ports-unmatched" : "edge-ports-ambiguous",
                    `%% edge-ports: ${edgeName(selector)} matches ${matches.length} existing edges; exactly one is required`,
                ),
            )
            continue
        }
        const edge = matches[0]
        if (decorations.has(edge)) {
            findings.push(
                finding(
                    diagram,
                    annotation,
                    "edge-ports-duplicate",
                    `%% edge-ports: ${edgeName(edge)} is decorated more than once`,
                ),
            )
            decorations.set(edge, null)
        } else {
            decorations.set(edge, validFrom && validTo ? annotation : null)
        }
    }
    return decorations
}

function checkBinding(diagram, contracts, edge, annotation, findings, connected) {
    const from = contracts.ports.get(edge.from)?.get(annotation.fromPort)
    const to = contracts.ports.get(edge.to)?.get(annotation.toPort)
    for (const [nodeId, portId, port] of [
        [edge.from, annotation.fromPort, from],
        [edge.to, annotation.toPort, to],
    ]) {
        if (!port) {
            findings.push(
                finding(
                    diagram,
                    annotation,
                    "edge-port-unknown",
                    `${edgeName(edge)} refers to undeclared port ${nodeId}.${portId}`,
                ),
            )
        }
    }
    if (!from || !to) return
    let valid = true
    const data = from.mode === "out" && to.mode === "in"
    const dependency = from.mode === "requires" && to.mode === "provides"
    if (!data && !dependency) {
        findings.push(
            finding(
                diagram,
                annotation,
                "port-direction-incompatible",
                `${edgeName(edge)} binds ${from.mode} -> ${to.mode}; only out -> in or requires -> provides is allowed`,
            ),
        )
        valid = false
    }
    if (dependency && edge.style !== "solid") {
        findings.push(
            finding(
                diagram,
                annotation,
                "port-requires-solid",
                `${edgeName(edge)} binds requires -> provides, which must use a solid edge`,
            ),
        )
        valid = false
    }
    if (from.type !== to.type) {
        findings.push(
            finding(
                diagram,
                annotation,
                "port-type-mismatch",
                `${edgeName(edge)} has different nominal contracts: ${JSON.stringify(from.type)} != ${JSON.stringify(to.type)}; case and versions are significant`,
            ),
        )
        valid = false
    }
    if (valid) {
        connected.add(from)
        connected.add(to)
    }
}

function checkCompleteInventory(diagram, contracts, inventory, decorations, connected, findings) {
    const nodeId = inventory.nodeId
    const ports = contracts.ports.get(nodeId)
    for (const port of ports?.values() ?? []) {
        if (port.required && !connected.has(port)) {
            findings.push(
                finding(
                    diagram,
                    port,
                    "port-required-unconnected",
                    `complete inventory ${nodeId} requires ${nodeId}.${port.id}, but no valid annotated edge connects it`,
                ),
            )
        }
    }
    for (const edge of diagram.edges) {
        if (edge.from !== nodeId && edge.to !== nodeId) continue
        const annotation = decorations.get(edge)
        const fromBound = edge.from !== nodeId || (annotation && ports?.has(annotation.fromPort))
        const toBound = edge.to !== nodeId || (annotation && ports?.has(annotation.toPort))
        if (!fromBound || !toBound) {
            findings.push(
                finding(
                    diagram,
                    edge,
                    "port-incident-edge-unbound",
                    `complete inventory ${nodeId} must bind every incident edge endpoint to a declared port: ${edgeName(edge)}`,
                ),
            )
        }
    }
}

/** Return fresh findings only; never mutate the diagram, its edges or inventories. */
export function checkPortContracts(diagram) {
    const contracts = diagram.portContracts
    if (!contracts?.enabled) {
        return [
            finding(
                diagram,
                null,
                "port-contracts-not-enabled",
                "no port annotations: inventories, endpoint bindings and nominal contracts were not checked (legacy diagram remains supported)",
                "not-checked",
            ),
        ]
    }
    const findings = contracts.annotationErrors.map((error) =>
        finding(diagram, error, error.rule, error.message, error.severity, "0"),
    )
    for (const inventory of contracts.inventories.values()) checkTarget(diagram, inventory, inventory.nodeId, findings)
    for (const [nodeId, ports] of contracts.ports) {
        for (const port of ports.values()) checkTarget(diagram, port, nodeId, findings)
    }

    const decorations = resolveDecorations(diagram, contracts, findings)
    const connected = new Set()
    for (const [edge, annotation] of decorations) {
        if (annotation) checkBinding(diagram, contracts, edge, annotation, findings, connected)
    }
    for (const inventory of contracts.inventories.values()) {
        if (
            inventory.completeness !== "complete" ||
            !diagram.nodes.has(inventory.nodeId) ||
            diagram.noteNodes?.has(inventory.nodeId)
        )
            continue
        checkCompleteInventory(diagram, contracts, inventory, decorations, connected, findings)
    }

    const partial = [...diagram.nodes.keys()].filter(
        (nodeId) => !diagram.noteNodes?.has(nodeId) && contracts.inventories.get(nodeId)?.completeness !== "complete",
    )
    if (partial.length > 0) {
        findings.push(
            finding(
                diagram,
                null,
                "port-inventory-partial",
                `partial or undeclared inventories (${partial.join(", ")}): only declared items were checked; required-port connectivity and incident-edge coverage were not checked for these nodes`,
                "not-checked",
            ),
        )
    }
    findings.push(
        finding(
            diagram,
            null,
            "port-runtime-not-checked",
            "nominal type agreement is diagram-level consistency only; code signatures, actual wiring and execution were not checked or proven",
            "not-checked",
        ),
    )
    return findings
}
