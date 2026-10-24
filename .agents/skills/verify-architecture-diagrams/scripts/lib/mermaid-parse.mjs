// Mermaid flowchart parser for the declared subset.
// Anything outside the subset is reported as a tooling problem, never as a design finding.

import { normalizeArchitectureIdentity } from "./architecture-identity.mjs"
import { ARTIFACT_EXPECTATIONS, ARTIFACT_ROLES } from "./evidence-model.mjs"

const NODE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*/

const SHAPES = [
    { open: "[[", close: "]]", name: "subroutine" },
    { open: "[(", close: ")]", name: "cylinder" },
    { open: "([", close: "])", name: "stadium" },
    { open: "{{", close: "}}", name: "hexagon" },
    { open: "[/", close: "/]", name: "parallelogram" },
    { open: "[\\", close: "\\]", name: "parallelogram-alt" },
    { open: "[", close: "]", name: "rect" },
    { open: "(", close: ")", name: "round" },
    { open: "{", close: "}", name: "rhombus" },
    { open: ">", close: "]", name: "asymmetric" },
]

const EDGE_FORMS = [
    { style: "dotted", re: /^-\.->/ },
    { style: "dotted", re: /^-\.\s*("[^"]*"|[^.]+?)\s*\.->/ },
    { style: "solid", re: /^--+>/ },
    { style: "solid", re: /^--\s*("[^"]*"|[^-][^>]*?)\s*--+>/ },
    { style: "solid", re: /^==+>/ },
    { style: "solid", re: /^---/ },
]

const SKIPPED_STATEMENT = /^(style|classDef|class|linkStyle|click|direction)\b/

export function unescapeLabel(raw) {
    return raw
        .replace(/\\n/g, " ")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
}

export function normalizeLabel(raw) {
    return normalizeArchitectureIdentity(unescapeLabel(raw ?? ""))
}

export function parseAttributes(text) {
    const attrs = {}
    for (const match of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|[^\s,]+)/g)) {
        let value = match[2]
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
        attrs[match[1]] = value
    }
    return attrs
}

function stripQuotes(value) {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
    return value
}

// Returns { node, nextIndex } or null when no node starts at index.
function readNode(text, index) {
    let cursor = index
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1
    const idMatch = NODE_ID.exec(text.slice(cursor))
    if (!idMatch) return null
    const id = idMatch[0]
    cursor += id.length

    let label = null
    let shape = "bare"

    const shapeStart = cursor
    for (const candidate of SHAPES) {
        if (!text.startsWith(candidate.open, cursor)) continue
        const bodyStart = cursor + candidate.open.length
        let bodyEnd
        let afterEnd
        if (text[bodyStart] === '"') {
            const closingQuote = text.indexOf('"', bodyStart + 1)
            if (closingQuote === -1) return null
            bodyEnd = closingQuote
            afterEnd = closingQuote + 1
            if (!text.startsWith(candidate.close, afterEnd)) continue
            afterEnd += candidate.close.length
        } else {
            const closing = text.indexOf(candidate.close, bodyStart)
            if (closing === -1) return null
            bodyEnd = closing
            afterEnd = closing + candidate.close.length
        }
        label = unescapeLabel(text.slice(bodyStart, bodyEnd))
        shape = candidate.name
        cursor = afterEnd
        break
    }
    if (label === null) cursor = shapeStart

    // Optional :::cssClass suffix.
    const classMatch = /^:::([A-Za-z0-9_-]+)/.exec(text.slice(cursor))
    if (classMatch) cursor += classMatch[0].length

    return { node: { id, label, shape }, nextIndex: cursor }
}

function readEdge(text, index) {
    let cursor = index
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1
    for (const form of EDGE_FORMS) {
        const match = form.re.exec(text.slice(cursor))
        if (!match) continue
        cursor += match[0].length
        let label = match[1] ?? null
        while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1
        if (text[cursor] === "|") {
            const closing = text.indexOf("|", cursor + 1)
            if (closing === -1) return null
            label = unescapeLabel(text.slice(cursor + 1, closing))
            cursor = closing + 1
        }
        return { edge: { style: form.style, label: label === null ? null : unescapeLabel(label) }, nextIndex: cursor }
    }
    return null
}

// Split on ";" only outside quoted strings, outside |edge labels| and outside
// node shapes. Real architecture diagrams put semicolons inside node labels
// such as SourceCheck{Shared-source publish check; no Task opening}.
function splitStatements(text) {
    const parts = []
    let current = ""
    let inDouble = false
    let inSingle = false
    let inLabel = false
    let shapeDepth = 0
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (char === "\\" && (inDouble || inSingle)) {
            current += char
            if (index + 1 < text.length) current += text[index + 1]
            index += 1
            continue
        }
        if (char === '"' && !inSingle) inDouble = !inDouble
        else if (char === "'" && !inDouble) inSingle = !inSingle
        else if (!inDouble && !inSingle) {
            if (char === "|") inLabel = !inLabel
            else if (!inLabel && (char === "{" || char === "[" || char === "(")) shapeDepth += 1
            else if (!inLabel && (char === "}" || char === "]" || char === ")")) shapeDepth = Math.max(0, shapeDepth - 1)
        }
        if (char === ";" && !inDouble && !inSingle && !inLabel && shapeDepth === 0) {
            parts.push(current)
            current = ""
            continue
        }
        current += char
    }
    parts.push(current)
    return parts
}

function parseStatement(text, line, diagram, problems) {
    const steps = []
    let cursor = 0
    for (;;) {
        const nodeResult = readNode(text, cursor)
        if (!nodeResult) {
            problems.push({
                file: diagram.file,
                line,
                message: `unsupported statement syntax: ${text.trim()}`,
            })
            return
        }
        steps.push({ node: nodeResult.node })
        cursor = nodeResult.nextIndex

        const edgeResult = readEdge(text, cursor)
        if (!edgeResult) {
            const rest = text.slice(cursor).trim()
            if (rest.length > 0 && rest !== ";") {
                problems.push({
                    file: diagram.file,
                    line,
                    message: `unsupported trailing syntax after node "${nodeResult.node.id}": ${rest}`,
                })
                return
            }
            break
        }
        steps.at(-1).edge = { ...edgeResult.edge, line, from: nodeResult.node.id }
        cursor = edgeResult.nextIndex
    }

    for (const step of steps) registerNode(diagram, step.node, line)
    for (let i = 0; i < steps.length - 1; i += 1) {
        const step = steps[i]
        diagram.edges.push({
            from: step.node.id,
            to: steps[i + 1].node.id,
            style: step.edge.style,
            label: step.edge.label,
            line: step.edge.line,
        })
    }
}

function registerNode(diagram, node, line) {
    const existing = diagram.nodes.get(node.id)
    if (!existing) {
        diagram.nodes.set(node.id, {
            id: node.id,
            label: node.label,
            shape: node.shape,
            subgraph: diagram.subgraphStack.at(-1)?.id ?? null,
            line,
        })
        return
    }
    if (node.label !== null) {
        existing.label = node.label
        existing.shape = node.shape
    }
}

function readSubgraphHeader(text) {
    const rest = text.replace(/^subgraph\s+/, "").trim()
    if (rest.length === 0) return null
    const labelled = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*\[\s*(?:"([^"]*)"|([^\]]*))\s*\]$/.exec(rest)
    if (labelled) {
        const label = unescapeLabel(labelled[2] ?? labelled[3] ?? labelled[1])
        return { id: labelled[1], label }
    }
    const idOnly = NODE_ID.exec(rest)
    if (idOnly && idOnly[0] === rest) return { id: rest, label: rest }
    return { id: rest.replace(/[^A-Za-z0-9_.-]/g, "_"), label: stripQuotes(rest) }
}

export const DIAGRAM_KINDS = ["structure", "flow"]

export function createDiagram(file, line) {
    return {
        file,
        line,
        direction: null,
        // Stable identity so other diagrams can name this one (%% refines:) and
        // reports survive line-number churn.
        id: null,
        layer: null,
        // "structure" diagrams carry the dependency graph and must be acyclic;
        // "flow" diagrams describe protocols and may loop as long as every loop
        // has an exit. null means the author did not say; callers treat that as
        // structure and report the omission once.
        kind: null,
        answers: null,
        // Diagram ids this diagram refines. Explicit refinement replaces the
        // overlap heuristic, which can only guess.
        refines: [],
        ignored: false,
        ignoreReason: null,
        cycleAllowed: [],
        modules: new Map(),
        // Repeatable node-to-code bindings. %% module: is projected into this
        // collection as declaration/present for backward compatibility.
        artifacts: new Map(),
        annotationFindings: [],
        annotationTargets: [],
        // nodeId -> concept name: the stable identity of a node across diagrams
        // whose authors chose different ids or label suffixes.
        concepts: new Map(),
        localOnly: new Set(),
        // Nodes that render a visible constraint and assert no relation.
        noteNodes: new Set(),
        notes: [],
        nodes: new Map(),
        edges: [],
        subgraphs: [],
        subgraphStack: [],
    }
}

// Nodes that participate in the graph checks: note nodes are legends.
export function graphNodeIds(diagram) {
    return [...diagram.nodes.keys()].filter((id) => !diagram.noteNodes.has(id))
}

// Stable cross-diagram identity of a node: declared concept, else the id.
export function conceptOf(diagram, nodeId) {
    return diagram.concepts.get(nodeId) ?? null
}

function annotationFinding(diagram, line, rule, message) {
    diagram.annotationFindings.push({
        severity: "blocking",
        attribution: "diagram",
        stage: "0",
        file: diagram.file,
        line,
        diagram: diagram.id ?? diagram.answers ?? null,
        rule,
        message,
    })
}

function addArtifact(diagram, nodeId, artifact) {
    if (!diagram.artifacts.has(nodeId)) diagram.artifacts.set(nodeId, [])
    diagram.artifacts.get(nodeId).push(artifact)
}

function trackAnnotationTarget(diagram, nodeId, kind, line) {
    diagram.annotationTargets.push({ nodeId, kind, line })
}

function applyAnnotation(diagram, text, line) {
    const body = text.replace(/^%%\s*/, "").trim()
    if (body.startsWith("{")) return
    const idMatch = /^id:\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*$/i.exec(body)
    if (idMatch) {
        diagram.id = idMatch[1]
        return
    }
    const layerMatch = /^layer:\s*(L\d+)/i.exec(body)
    if (layerMatch) {
        diagram.layer = layerMatch[1].toUpperCase()
        return
    }
    const kindMatch = /^kind:\s*([A-Za-z]+)/i.exec(body)
    if (kindMatch) {
        const kind = kindMatch[1].toLowerCase()
        diagram.kind = DIAGRAM_KINDS.includes(kind) ? kind : `invalid:${kindMatch[1]}`
        return
    }
    // A cross-cutting diagram may legitimately answer more than one question;
    // several answers lines accumulate instead of overwriting each other.
    const answersMatch = /^answers:\s*(.+)$/i.exec(body)
    if (answersMatch) {
        const answer = answersMatch[1].trim()
        diagram.answers = diagram.answers ? `${diagram.answers}; ${answer}` : answer
        return
    }
    const refinesMatch = /^refines:\s*(.+)$/i.exec(body)
    if (refinesMatch) {
        for (const entry of refinesMatch[1].split(",")) {
            const id = entry.trim()
            if (id.length > 0) diagram.refines.push(id)
        }
        return
    }
    const conceptMatch = /^concept:\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*=\s*(.+)$/i.exec(body)
    if (conceptMatch) {
        diagram.concepts.set(conceptMatch[1], conceptMatch[2].trim())
        trackAnnotationTarget(diagram, conceptMatch[1], "concept", line)
        return
    }
    const noteNodeMatch = /^note-node:\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)/i.exec(body)
    if (noteNodeMatch) {
        diagram.noteNodes.add(noteNodeMatch[1])
        trackAnnotationTarget(diagram, noteNodeMatch[1], "note-node", line)
        return
    }
    if (/^cycle:\s*allowed\b/i.test(body)) {
        const attrs = parseAttributes(body)
        const nodes = (attrs.nodes ?? "")
            .split("|")
            .map((entry) => entry.trim())
            .filter(Boolean)
        diagram.cycleAllowed.push({ owner: attrs.owner ?? null, reason: attrs.reason ?? null, nodes, line })
        return
    }
    const moduleMatch = /^module:\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*=\s*(.+)$/i.exec(body)
    if (moduleMatch) {
        const nodeId = moduleMatch[1]
        const modulePath = moduleMatch[2].trim()
        diagram.modules.set(nodeId, modulePath)
        addArtifact(diagram, nodeId, {
            role: "declaration",
            path: modulePath,
            symbol: null,
            expectation: "present",
            line,
            source: "module",
        })
        trackAnnotationTarget(diagram, nodeId, "module", line)
        return
    }
    const artifactMatch = /^artifact:\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*(.*)$/i.exec(body)
    if (artifactMatch) {
        const nodeId = artifactMatch[1]
        const attrs = parseAttributes(artifactMatch[2])
        const role = attrs.role ?? ""
        const expectation = attrs.expect ?? attrs.expectation ?? "present"
        const artifact = {
            role,
            path: attrs.path ?? "",
            symbol: attrs.symbol ?? null,
            expectation,
            canonicalSource: attrs.source ?? null,
            provenance: attrs.provenance ?? null,
            line,
            source: "artifact",
        }
        addArtifact(diagram, nodeId, artifact)
        trackAnnotationTarget(diagram, nodeId, "artifact", line)
        if (!ARTIFACT_ROLES.has(role)) {
            annotationFinding(
                diagram,
                line,
                "artifact-role-unknown",
                `%% artifact: ${nodeId} uses unknown role "${role || "missing"}"`,
            )
        }
        if (!ARTIFACT_EXPECTATIONS.has(expectation)) {
            annotationFinding(
                diagram,
                line,
                "artifact-expectation-unknown",
                `%% artifact: ${nodeId} uses unknown expectation "${expectation}"`,
            )
        }
        if (!artifact.path) {
            annotationFinding(diagram, line, "artifact-path-missing", `%% artifact: ${nodeId} requires path=<path>`)
        }
        if (expectation === "generated" && (!artifact.canonicalSource || !artifact.provenance)) {
            annotationFinding(
                diagram,
                line,
                "generated-provenance-missing",
                `%% artifact: ${nodeId} expect=generated requires source= and provenance=`,
            )
        }
        return
    }
    const localMatch = /^local-only:\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)/i.exec(body)
    if (localMatch) {
        diagram.localOnly.add(localMatch[1])
        trackAnnotationTarget(diagram, localMatch[1], "local-only", line)
        return
    }
    if (/^ignore:/i.test(body)) {
        const attrs = parseAttributes(body)
        diagram.ignored = true
        diagram.ignoreReason = { owner: attrs.owner ?? null, reason: attrs.reason ?? null }
        return
    }
    if (/^note:/i.test(body)) {
        diagram.notes.push(body.replace(/^note:\s*/i, "").trim())
    }
}

export function parseFlowchart(lines, { file, firstLine }) {
    const diagram = createDiagram(file, firstLine)
    const problems = []

    let index = 0
    while (index < lines.length && lines[index].trim().length === 0) index += 1
    const header = /^(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)\s*$/.exec((lines[index] ?? "").trim())
    if (!header) {
        problems.push({ file, line: firstLine + index, message: "missing flowchart header" })
        return { diagram, problems }
    }
    diagram.direction = header[1]
    index += 1

    for (; index < lines.length; index += 1) {
        const raw = lines[index]
        const line = firstLine + index
        const text = raw.trim()
        if (text.length === 0) continue
        if (text.startsWith("%%")) {
            applyAnnotation(diagram, text, line)
            continue
        }
        if (/^subgraph\b/.test(text)) {
            const headerInfo = readSubgraphHeader(text)
            if (!headerInfo) {
                problems.push({ file, line, message: "malformed subgraph header" })
                continue
            }
            const parent = diagram.subgraphStack.at(-1)?.id ?? null
            diagram.subgraphs.push({ ...headerInfo, parent, line })
            diagram.subgraphStack.push(headerInfo)
            continue
        }
        if (text === "end") {
            if (diagram.subgraphStack.length === 0) {
                problems.push({ file, line, message: "unmatched subgraph end" })
                continue
            }
            diagram.subgraphStack.pop()
            continue
        }
        if (SKIPPED_STATEMENT.test(text)) continue
        for (const statement of splitStatements(text)) {
            if (statement.trim().length === 0) continue
            parseStatement(statement, line, diagram, problems)
        }
    }

    if (diagram.subgraphStack.length > 0) {
        problems.push({ file, line: firstLine + lines.length - 1, message: "unclosed subgraph" })
    }
    for (const target of diagram.annotationTargets) {
        if (diagram.nodes.has(target.nodeId)) continue
        annotationFinding(
            diagram,
            target.line,
            `${target.kind}-node-unknown`,
            `%% ${target.kind}: names node ${target.nodeId}, but the diagram does not draw it`,
        )
    }
    diagram.subgraphStack = []
    return { diagram, problems }
}

export function extractMermaidBlocks(markdown, file) {
    const lines = markdown.split(/\r?\n/)
    const blocks = []
    let open = null
    for (let index = 0; index < lines.length; index += 1) {
        const fence = /^\s*```(\S*)\s*$/.exec(lines[index])
        if (!fence) continue
        if (open === null) {
            open = { lang: fence[1].toLowerCase(), index }
            continue
        }
        if (open.lang === "mermaid") {
            blocks.push({
                file,
                firstLine: open.index + 2,
                lines: lines.slice(open.index + 1, index),
            })
        }
        open = null
    }
    return blocks
}
