// Architecture Evidence is the sole task-local diagram-to-code mapping.
// Schema v2 gives every artifact a stable id and requires every edge endpoint
// to bind both a diagram node and one of those artifacts. Schema v1 remains
// readable for migration, but callers report it as legacy evidence.

import { parseYamlLite, YamlLiteError } from "./yaml-lite.mjs"

export const EVIDENCE_SCHEMA_VERSION = 2

export const ARTIFACT_ROLES = new Set(["declaration", "assembly", "writer", "reader", "emitter", "receiver", "generated"])

export const ARTIFACT_EXPECTATIONS = new Set(["present", "absent", "generated"])
export const EDGE_KINDS = new Set(["direct_import", "injected_port", "composition", "event", "callback", "rpc"])

const ENDPOINT_ROLES = new Map([
    ["emit", "emitter"],
    ["receive", "receiver"],
    ["contract", "declaration"],
    ["assembly", "assembly"],
])

function text(value) {
    return typeof value === "string" ? value.trim() : ""
}

function asArray(value) {
    if (value === null || value === undefined) return []
    return Array.isArray(value) ? value : [value]
}

function problem(rule, message, file, line = null) {
    return { rule, message, file, line }
}

function normalizeLegacyEndpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const artifactPath = text(value.path)
    if (!artifactPath) return null
    return {
        node: null,
        artifactId: null,
        role: null,
        path: artifactPath,
        symbol: text(value.symbol) || null,
    }
}

function normalizeArtifact(raw, context, problems, { requireId, artifactById }) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        problems.push(problem("artifact-invalid", `${context.label} must be a mapping`, context.file))
        return null
    }
    const id = text(raw.id)
    const role = text(raw.role)
    const expectation = text(raw.expectation ?? raw.expect) || "present"
    const artifactPath = text(raw.path)
    if (requireId && !id) {
        problems.push(problem("artifact-id-missing", `${context.label} has no stable artifact id`, context.file))
    }
    if (id && artifactById.has(id)) {
        problems.push(problem("artifact-id-duplicate", `artifact id "${id}" is duplicated`, context.file))
    }
    if (!ARTIFACT_ROLES.has(role)) {
        problems.push(
            problem("artifact-role-unknown", `${context.label} uses unknown artifact role "${role || "missing"}"`, context.file),
        )
    }
    if (!ARTIFACT_EXPECTATIONS.has(expectation)) {
        problems.push(
            problem(
                "artifact-expectation-unknown",
                `${context.label} uses unknown expectation "${expectation || "missing"}"`,
                context.file,
            ),
        )
    }
    if (!artifactPath) problems.push(problem("artifact-path-missing", `${context.label} has no artifact path`, context.file))
    const canonicalSource = text(raw.canonical_source ?? raw.source) || null
    const provenance = text(raw.provenance) || null
    if (expectation === "generated" && (!canonicalSource || !provenance)) {
        problems.push(
            problem(
                "generated-provenance-missing",
                `${context.label} expects generated output but omits canonical source or provenance`,
                context.file,
            ),
        )
    }
    const artifact = {
        id: id || null,
        node: context.nodeId,
        role,
        path: artifactPath,
        symbol: text(raw.symbol) || null,
        expectation,
        canonicalSource,
        provenance,
    }
    if (id && !artifactById.has(id)) artifactById.set(id, artifact)
    return artifact
}

function endpointLocation(endpoint) {
    if (!endpoint?.path) return null
    const artifactPath = endpoint.path.normalize("NFKC").replaceAll("\\", "/").toLowerCase()
    return `${artifactPath}#${(endpoint.symbol ?? "").normalize("NFKC").toLowerCase()}`
}

function normalizeBoundEndpoint(value, endpointName, edgeName, artifactById, problems, file) {
    if (value === null || value === undefined) return null
    if (typeof value !== "object" || Array.isArray(value)) {
        problems.push(problem("evidence-endpoint-invalid", `${edgeName} ${endpointName} endpoint must be a mapping`, file))
        return null
    }
    const node = text(value.node)
    const artifactId = text(value.artifact)
    if (!node) problems.push(problem("evidence-endpoint-node-missing", `${edgeName} ${endpointName} endpoint has no node`, file))
    if (!artifactId)
        problems.push(
            problem("evidence-endpoint-artifact-missing", `${edgeName} ${endpointName} endpoint has no artifact id`, file),
        )
    if (text(value.path) || text(value.symbol)) {
        problems.push(
            problem(
                "evidence-endpoint-inline-location",
                `${edgeName} ${endpointName} endpoint must reference an artifact id instead of declaring path or symbol`,
                file,
            ),
        )
    }
    const artifact = artifactById.get(artifactId)
    if (artifactId && !artifact) {
        problems.push(
            problem(
                "evidence-endpoint-artifact-unknown",
                `${edgeName} ${endpointName} references unknown artifact "${artifactId}"`,
                file,
            ),
        )
    }
    if (artifact && node && artifact.node !== node) {
        problems.push(
            problem(
                "evidence-endpoint-artifact-node-mismatch",
                `${edgeName} ${endpointName} binds node ${node} to artifact ${artifactId}, which belongs to node ${artifact.node}`,
                file,
            ),
        )
    }
    const requiredRole = ENDPOINT_ROLES.get(endpointName)
    if (artifact && requiredRole && artifact.role !== requiredRole) {
        problems.push(
            problem(
                "evidence-endpoint-role-mismatch",
                `${edgeName} ${endpointName} requires role ${requiredRole}, but artifact ${artifactId} has role ${artifact.role || "missing"}`,
                file,
            ),
        )
    }
    return {
        node: node || null,
        artifactId: artifactId || null,
        role: artifact?.role ?? null,
        path: artifact?.path ?? null,
        symbol: artifact?.symbol ?? null,
    }
}

function normalizeEvidence(raw, file, problems) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        problems.push(problem("architecture-evidence-invalid", "architecture_evidence must be a mapping", file))
        return null
    }
    const schemaVersion = raw.schema_version
    if (schemaVersion === 1) {
        problems.push(
            problem(
                "architecture-evidence-legacy-schema",
                "architecture_evidence schema_version 1 is migration-only and cannot establish completed conformance; migrate to schema_version 2",
                file,
            ),
        )
    } else if (schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
        problems.push(
            problem(
                "architecture-evidence-schema",
                `unsupported architecture_evidence schema_version ${String(schemaVersion)}`,
                file,
            ),
        )
    }
    const requireArtifactIds = schemaVersion === EVIDENCE_SCHEMA_VERSION
    const diagramId = text(raw.diagram_id)
    if (!diagramId)
        problems.push(problem("architecture-evidence-diagram-missing", "architecture_evidence.diagram_id is required", file))

    const nodes = new Map()
    const artifactById = new Map()
    if (raw.nodes !== null && raw.nodes !== undefined && (typeof raw.nodes !== "object" || Array.isArray(raw.nodes))) {
        problems.push(problem("architecture-evidence-nodes-invalid", "architecture_evidence.nodes must be a mapping", file))
    } else {
        for (const [nodeId, nodeRecord] of Object.entries(raw.nodes ?? {})) {
            const artifacts = asArray(nodeRecord?.artifacts)
                .map((artifact, index) =>
                    normalizeArtifact(artifact, { file, nodeId, label: `node ${nodeId} artifact ${index + 1}` }, problems, {
                        requireId: requireArtifactIds,
                        artifactById,
                    }),
                )
                .filter(Boolean)
            nodes.set(nodeId, { artifacts })
        }
    }

    const edges = []
    const edgeIds = new Set()
    for (const [index, rawEdge] of asArray(raw.edges).entries()) {
        if (!rawEdge || typeof rawEdge !== "object" || Array.isArray(rawEdge)) {
            problems.push(problem("evidence-edge-invalid", `edge ${index + 1} must be a mapping`, file))
            continue
        }
        const id = text(rawEdge.id)
        const edgeName = `edge ${id || index + 1}`
        if (!id) problems.push(problem("evidence-edge-id-missing", `edge ${index + 1} has no id`, file))
        else if (edgeIds.has(id)) problems.push(problem("evidence-edge-id-duplicate", `edge id "${id}" is duplicated`, file))
        else edgeIds.add(id)
        const kind = text(rawEdge.kind)
        if (!kind) problems.push(problem("evidence-edge-kind-missing", `${edgeName} has no proof kind`, file))
        else if (!EDGE_KINDS.has(kind))
            problems.push(problem("evidence-edge-kind-unknown", `${edgeName} uses unknown kind "${kind}"`, file))
        const from = text(rawEdge.from)
        const to = text(rawEdge.to)
        const normalizeEndpoint = requireArtifactIds
            ? (value, name) => normalizeBoundEndpoint(value, name, edgeName, artifactById, problems, file)
            : (value) => normalizeLegacyEndpoint(value)
        const emit = normalizeEndpoint(rawEdge.emit, "emit")
        const receive = normalizeEndpoint(rawEdge.receive, "receive")
        const contract = normalizeEndpoint(rawEdge.contract, "contract")
        const assembly = normalizeEndpoint(rawEdge.assembly, "assembly")
        if (requireArtifactIds) {
            if (!emit) problems.push(problem("evidence-edge-emit-missing", `${edgeName} has no emit endpoint`, file))
            if (!receive) problems.push(problem("evidence-edge-receive-missing", `${edgeName} has no receive endpoint`, file))
            if (emit?.node && from && emit.node !== from) {
                problems.push(
                    problem("evidence-edge-emit-node-mismatch", `${edgeName} from=${from} but emit.node=${emit.node}`, file),
                )
            }
            if (receive?.node && to && receive.node !== to) {
                problems.push(
                    problem("evidence-edge-receive-node-mismatch", `${edgeName} to=${to} but receive.node=${receive.node}`, file),
                )
            }
            if (emit?.artifactId && receive?.artifactId && emit.artifactId === receive.artifactId) {
                problems.push(
                    problem(
                        "evidence-edge-endpoint-artifact-reused",
                        `${edgeName} uses artifact ${emit.artifactId} for both emit and receive`,
                        file,
                    ),
                )
            }
            const emitLocation = endpointLocation(emit)
            const receiveLocation = endpointLocation(receive)
            if (emitLocation && emitLocation === receiveLocation) {
                problems.push(
                    problem(
                        "evidence-edge-endpoint-location-reused",
                        `${edgeName} emit and receive resolve to the same path and symbol`,
                        file,
                    ),
                )
            }
            if (["injected_port", "event", "callback"].includes(kind) && !contract) {
                problems.push(
                    problem("evidence-edge-contract-missing", `${edgeName} kind ${kind} requires a contract endpoint`, file),
                )
            }
        }
        edges.push({
            id,
            from,
            to,
            style: text(rawEdge.style),
            label: text(rawEdge.label),
            kind,
            emit,
            receive,
            contract,
            assembly,
            rpc:
                rawEdge.rpc && typeof rawEdge.rpc === "object"
                    ? { service: text(rawEdge.rpc.service), method: text(rawEdge.rpc.method) }
                    : null,
            proof: asArray(rawEdge.proof).map(text).filter(Boolean),
        })
    }

    return {
        schemaVersion,
        diagramId,
        nodes,
        artifactById,
        edges,
        file,
        legacy: schemaVersion === 1,
    }
}

function evidenceSections(markdown) {
    const lines = markdown.split(/\r?\n/)
    const headings = []
    for (let index = 0; index < lines.length; index += 1) {
        if (/^##\s+Architecture Evidence\s*$/.test(lines[index].trim())) headings.push(index)
    }
    if (headings.length !== 1) return { headings, blocks: [] }
    const start = headings[0] + 1
    let end = lines.length
    for (let index = start; index < lines.length; index += 1) {
        if (/^#{1,2}\s+/.test(lines[index].trim())) {
            end = index
            break
        }
    }
    const blocks = []
    let open = null
    for (let index = start; index < end; index += 1) {
        const fence = /^\s*```(yaml|yml)?\s*$/.exec(lines[index])
        if (!fence) continue
        if (open === null) open = { index, lang: fence[1] ?? "" }
        else {
            blocks.push({ line: open.index + 1, content: lines.slice(open.index + 1, index).join("\n") })
            open = null
        }
    }
    return { headings, blocks }
}

export function parseArchitectureEvidence(markdown, file) {
    const problems = []
    const sections = evidenceSections(markdown)
    if (sections.headings.length === 0) return { evidence: null, problems }
    if (sections.headings.length > 1) {
        return {
            evidence: null,
            problems: [
                problem("architecture-evidence-duplicate", "plan.md contains more than one Architecture Evidence section", file),
            ],
        }
    }
    if (sections.blocks.length !== 1) {
        return {
            evidence: null,
            problems: [
                problem("architecture-evidence-block-count", "Architecture Evidence must contain exactly one YAML block", file),
            ],
        }
    }
    try {
        const document = parseYamlLite(sections.blocks[0].content)
        if (!document || typeof document !== "object" || Array.isArray(document) || !("architecture_evidence" in document)) {
            problems.push(
                problem(
                    "architecture-evidence-root",
                    "YAML block must contain architecture_evidence",
                    file,
                    sections.blocks[0].line,
                ),
            )
            return { evidence: null, problems }
        }
        return { evidence: normalizeEvidence(document.architecture_evidence, file, problems), problems }
    } catch (error) {
        if (!(error instanceof YamlLiteError)) throw error
        return {
            evidence: null,
            problems: [
                problem(
                    "architecture-evidence-yaml",
                    `Architecture Evidence YAML parse error: ${error.message}`,
                    file,
                    sections.blocks[0].line,
                ),
            ],
        }
    }
}

export function validateEvidenceAgainstDiagram(evidence, diagram) {
    const findings = []
    const add = (rule, message) => findings.push({ rule, message, file: evidence.file, line: null })
    if (evidence.diagramId !== diagram.id) {
        add(
            "evidence-diagram-mismatch",
            `evidence names diagram ${evidence.diagramId || "missing"}, but the selected diagram is ${diagram.id || "missing"}`,
        )
    }
    for (const nodeId of evidence.nodes.keys()) {
        if (!diagram.nodes.has(nodeId))
            add("evidence-node-unknown", `evidence node ${nodeId} does not exist in diagram ${diagram.id ?? diagram.file}`)
    }
    for (const edge of evidence.edges) {
        const exact = diagram.edges.some(
            (candidate) =>
                candidate.from === edge.from &&
                candidate.to === edge.to &&
                candidate.style === edge.style &&
                (candidate.label ?? "") === edge.label,
        )
        if (!exact) {
            add(
                "evidence-edge-mismatch",
                `evidence edge ${edge.id || `${edge.from}->${edge.to}`} does not exactly match diagram from/to/style/label`,
            )
        }
        if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) continue
        for (const [endpointName, endpoint] of [
            ["emit", edge.emit],
            ["receive", edge.receive],
            ["contract", edge.contract],
            ["assembly", edge.assembly],
        ]) {
            if (!endpoint) continue
            if (endpoint.node && !diagram.nodes.has(endpoint.node)) {
                add(
                    "evidence-endpoint-node-unknown",
                    `edge ${edge.id} ${endpointName} node ${endpoint.node} does not exist in diagram ${diagram.id}`,
                )
            }
            const artifact = evidence.artifactById?.get(endpoint.artifactId)
            if (!artifact) {
                add(
                    "evidence-endpoint-artifact-unknown",
                    `edge ${edge.id} ${endpointName} artifact ${endpoint.artifactId || "missing"} is not declared`,
                )
            } else if (artifact.node !== endpoint.node) {
                add(
                    "evidence-endpoint-artifact-node-mismatch",
                    `edge ${edge.id} ${endpointName} node ${endpoint.node} does not own artifact ${endpoint.artifactId}`,
                )
            }
        }
        if (edge.emit?.node && edge.emit.node !== edge.from) {
            add("evidence-edge-emit-node-mismatch", `edge ${edge.id} from=${edge.from} but emit.node=${edge.emit.node}`)
        }
        if (edge.receive?.node && edge.receive.node !== edge.to) {
            add("evidence-edge-receive-node-mismatch", `edge ${edge.id} to=${edge.to} but receive.node=${edge.receive.node}`)
        }
    }
    return findings
}
