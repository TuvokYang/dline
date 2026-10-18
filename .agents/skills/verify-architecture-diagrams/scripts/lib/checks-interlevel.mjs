// Stage 3 (B1): inter-level refinement from L0 down to L5.
// A finer layer may refine a coarser one, never invent authority, scope or direction.

const LAYER_ORDER = ["L0", "L1", "L2", "L3", "L4", "L5"]

function layerIndex(layer) {
    const index = LAYER_ORDER.indexOf(layer)
    return index === -1 ? null : index
}

function finding(severity, diagram, subject, rule, message, bind) {
    return {
        severity,
        attribution: "diagram",
        stage: "3",
        file: diagram.file,
        line: subject?.line ?? diagram.line,
        diagram: diagram.answers ?? diagram.layer ?? diagram.file,
        rule,
        message,
        bind,
    }
}

function normalize(label) {
    return (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

// Node identity: declared concept, then exact id, then normalized label,
// otherwise unresolved. A concept is the author's statement that two differently
// named nodes are one architectural thing; it is matched against the coarse
// node's own concept, its id and its normalized label.
export function resolveNode(fineNode, coarseDiagram, fineDiagram = null) {
    const concept = fineDiagram?.concepts?.get(fineNode.id) ?? null
    if (concept) {
        const wanted = normalize(concept)
        for (const candidate of coarseDiagram.nodes.values()) {
            const candidateConcept = coarseDiagram.concepts?.get(candidate.id) ?? null
            if (candidateConcept && normalize(candidateConcept) === wanted) return { node: candidate, strategy: "concept" }
            if (normalize(candidate.id) === wanted || normalize(candidate.label) === wanted)
                return { node: candidate, strategy: "concept" }
        }
    }
    const exact = coarseDiagram.nodes.get(fineNode.id)
    if (exact) return { node: exact, strategy: "id" }
    const label = normalize(fineNode.label)
    if (label.length > 0) {
        for (const candidate of coarseDiagram.nodes.values()) {
            if (normalize(candidate.label) === label) return { node: candidate, strategy: "label" }
        }
    }
    return { node: null, strategy: "unresolved" }
}

// A pairing the author did not declare can only be a guess, and a guess must
// not block. Findings that depend on it are reported for review instead.
function softenUndeclared(findings, declared, coarse) {
    if (declared) return findings
    return findings.map((entry) =>
        entry.severity === "unverifiable"
            ? {
                  ...entry,
                  severity: "not-checked",
                  message: `${entry.message} (pairing with ${coarse.id ?? coarse.layer} was inferred; declare %% refines: to verify)`,
              }
            : entry,
    )
}

export function checkInterLevel(coarse, fine, context) {
    const declared = context?.declared !== false
    return softenUndeclared(checkInterLevelDeclared(coarse, fine, context), declared, coarse)
}

function checkInterLevelDeclared(coarse, fine, context) {
    const findings = []
    const coarseLayer = layerIndex(coarse.layer)
    const fineLayer = layerIndex(fine.layer)

    if (coarseLayer === null || fineLayer === null) {
        findings.push(
            finding(
                "unverifiable",
                fine,
                null,
                "layer-annotation-missing",
                `inter-level comparison needs %% layer: on both diagrams; coarse=${coarse.layer ?? "missing"} fine=${fine.layer ?? "missing"}`,
            ),
        )
        return findings
    }
    if (fineLayer <= coarseLayer) {
        findings.push(
            finding(
                "blocking",
                fine,
                null,
                "layer-order",
                `fine diagram ${fine.layer} must refine a coarser layer, but coarse is ${coarse.layer}`,
            ),
        )
        return findings
    }

    const declared = new Set(coarse.nodes.keys())
    const labelIndex = new Map()
    for (const node of coarse.nodes.values()) labelIndex.set(normalize(node.label), node.id)

    const resolved = new Map()
    for (const fineNode of fine.nodes.values()) {
        if (fine.localOnly.has(fineNode.id)) continue
        if (fine.noteNodes.has(fineNode.id)) continue
        if (context?.allowedLocalNodes?.has(fineNode.id)) continue
        const match = resolveNode(fineNode, coarse, fine)
        if (match.node) {
            resolved.set(fineNode.id, match.node.id)
            continue
        }
        findings.push({
            ...finding(
                "unverifiable",
                fine,
                { line: fineNode.line },
                "node-unresolved",
                `node ${fineNode.id} ("${fineNode.label ?? ""}") is neither an id, a normalized label in ${coarse.layer}, nor declared local-only`,
                undefined,
            ),
        })
    }

    for (const edge of fine.edges) {
        const from = resolved.get(edge.from)
        const to = resolved.get(edge.to)
        if (!from || !to) continue
        const coarseEdge = coarse.edges.find((candidate) => candidate.from === from && candidate.to === to)
        if (!coarseEdge) {
            // Only a solid edge can invert a dependency. A dotted edge reports a fact,
            // and facts naturally travel back toward their orchestrator.
            const reverse =
                edge.style === "solid"
                    ? coarse.edges.find(
                          (candidate) => candidate.from === to && candidate.to === from && candidate.style === "solid",
                      )
                    : null
            if (reverse) {
                findings.push(
                    finding(
                        "blocking",
                        fine,
                        edge,
                        "edge-direction-inverted",
                        `${fine.layer} edge ${edge.from} -> ${edge.to} inverts ${coarse.layer} edge ${reverse.from} -> ${reverse.to}`,
                    ),
                )
            } else if (edge.style === "solid") {
                findings.push({
                    ...finding(
                        "unverifiable",
                        fine,
                        edge,
                        "edge-undeclared-upstream",
                        `${fine.layer} command edge ${from} -> ${to} has no ${coarse.layer} counterpart; declare it in ${coarse.layer} or bind it to a spec sentence`,
                    ),
                })
            } else {
                findings.push({
                    ...finding(
                        "not-checked",
                        fine,
                        edge,
                        "extra-dotted-edge",
                        `${fine.layer} adds fact edge ${from} -.-> ${to} that ${coarse.layer} does not state; it is treated as refinement detail`,
                    ),
                })
            }
            continue
        }
        if (coarseEdge.style === "solid" && edge.style === "dotted") {
            findings.push(
                finding(
                    "blocking",
                    fine,
                    edge,
                    "edge-style-downgraded",
                    `${fine.layer} draws ${edge.from} -.-> ${edge.to} where ${coarse.layer} declares a solid command edge`,
                ),
            )
        }
        if (coarseEdge.style === "dotted" && edge.style === "solid") {
            findings.push(
                finding(
                    "blocking",
                    fine,
                    edge,
                    "dotted-upgraded-to-command",
                    `${fine.layer} draws ${edge.from} --> ${edge.to} as a command where ${coarse.layer} declares a fact edge`,
                ),
            )
        }
    }

    // New lifetime scopes may not appear below L0.
    for (const subgraph of fine.subgraphs) {
        const known = coarse.subgraphs.some((candidate) => normalize(candidate.label) === normalize(subgraph.label))
        if (!known && coarseLayer > 0) {
            findings.push({
                ...finding(
                    "unverifiable",
                    fine,
                    { line: subgraph.line },
                    "new-lifetime-scope",
                    `subgraph "${subgraph.label}" introduces a lifetime not present in ${coarse.layer}`,
                    "bind the subgraph to a spec sentence declaring the scope",
                ),
            })
        }
    }

    for (const nodeId of declared) {
        if (coarse.noteNodes.has(nodeId)) continue
        if ([...resolved.values()].includes(nodeId)) continue
        findings.push({
            ...finding(
                "not-checked",
                fine,
                null,
                "coarse-node-not-refined",
                `${coarse.layer} node ${nodeId} does not appear in ${fine.layer}; coverage of that node is not verified`,
            ),
        })
    }

    return findings
}

export function checkLayerSequence(diagrams) {
    const findings = []
    const ordered = diagrams
        .filter((diagram) => diagram.layer)
        .slice()
        .sort((a, b) => layerIndex(a.layer) - layerIndex(b.layer))
    for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1]
        const current = ordered[index]
        if (previous.layer === current.layer) continue
        const previousIndex = layerIndex(previous.layer)
        const currentIndex = layerIndex(current.layer)
        if (currentIndex !== previousIndex + 1) {
            findings.push({
                severity: "unverifiable",
                attribution: "diagram",
                stage: "3",
                file: current.file,
                line: current.line,
                diagram: current.answers ?? current.layer,
                rule: "layer-skipped",
                message: `layer ${previous.layer} is followed by ${current.layer}; the skipped refinement is not verified`,
            })
        }
    }
    return findings
}

export { LAYER_ORDER }
