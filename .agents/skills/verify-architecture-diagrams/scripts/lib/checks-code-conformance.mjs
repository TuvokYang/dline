// Stage 7: bounded comparison of diagram, task, evidence and canonical code facts.
// The provider scans only explicit current-Workstream artifact/owns/reads files.

import fs from "node:fs"
import path from "node:path"
import { canonicalNodeKey, normalizeArchitectureIdentity } from "./architecture-identity.mjs"
import { createCodeFactSnapshot } from "./code-facts.mjs"
import { validateEvidenceAgainstDiagram } from "./evidence-model.mjs"
import { buildDependencyClosure } from "./tree-sitter-dependencies.mjs"
import { languageForPath } from "./tree-sitter-runtime.mjs"

const COMPUTABLE_BOUNDARIES = new Set(["whole_file", "module", "symbol"])
const COMPLETED = "completed"

function canonicalPath(value) {
    return String(value ?? "")
        .normalize("NFKC")
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
        .replace(/\/+/g, "/")
        .toLowerCase()
}

function finding(severity, rule, message, { task = null, file = null, line = null, attribution = "code" } = {}) {
    return {
        severity,
        attribution,
        stage: "7",
        file,
        line,
        diagram: task,
        rule,
        message,
        task,
    }
}

export function classifyExpectationMismatch(status) {
    return status === COMPLETED ? "blocking" : "warning"
}

function endpointPath(endpoint) {
    return canonicalPath(endpoint?.path)
}

function importTargets(edge, targetPath) {
    const wanted = canonicalPath(targetPath)
    if (edge.target?.kind === "workspace" && canonicalPath(edge.target.path) === wanted) return true
    return (
        edge.bindings?.some((binding) =>
            binding.provenance?.declarations?.some(
                (declaration) => declaration.origin === "workspace" && canonicalPath(declaration.path) === wanted,
            ),
        ) ?? false
    )
}

function hasImport(codeSnapshot, importer, target, { runtime = false } = {}) {
    const source = canonicalPath(importer)
    return codeSnapshot.imports.some(
        (edge) => canonicalPath(edge.importer) === source && (!runtime || !edge.typeOnly) && importTargets(edge, target),
    )
}

function endpointPresent(endpoint, presentArtifacts) {
    return Boolean(endpoint?.path) && presentArtifacts.has(canonicalPath(endpoint.path))
}

function proofResult(status, adapter, reason) {
    return Object.freeze({ status, proven: status === "proven", adapter, reason })
}

export function proveEvidenceEdge({ edge, codeSnapshot, presentArtifacts }) {
    const kind = edge.kind
    const contradicted = (reason) => proofResult("contradicted", kind, reason)
    const proven = (reason) => proofResult("proven", kind, reason)
    const unverifiable = (reason) => proofResult("unverifiable", kind, reason)
    if (!edge.emit || !edge.receive) return contradicted("emit and receive endpoints are required")
    if (!endpointPresent(edge.emit, presentArtifacts) || !endpointPresent(edge.receive, presentArtifacts)) {
        return contradicted("emit or receive artifact is absent")
    }

    if (kind === "direct_import") {
        return hasImport(codeSnapshot, edge.emit.path, edge.receive.path, { runtime: true })
            ? proven("runtime import connects emit to receive")
            : contradicted("no runtime import connects emit to receive")
    }
    if (kind === "injected_port") {
        if (!edge.contract || !endpointPresent(edge.contract, presentArtifacts))
            return contradicted("port contract artifact is absent")
        if (
            !hasImport(codeSnapshot, edge.emit.path, edge.contract.path) ||
            !hasImport(codeSnapshot, edge.receive.path, edge.contract.path)
        ) {
            return contradicted("both endpoints do not reference the injected port contract")
        }
        return unverifiable(
            "contract references exist, but generic syntax facts cannot prove runtime dependency injection or assembly",
        )
    }
    if (kind === "composition") {
        if (edge.assembly && endpointPresent(edge.assembly, presentArtifacts)) {
            return hasImport(codeSnapshot, edge.assembly.path, edge.emit.path, { runtime: true }) &&
                hasImport(codeSnapshot, edge.assembly.path, edge.receive.path, { runtime: true })
                ? proven("composition artifact has runtime imports to both endpoints")
                : contradicted("composition artifact does not have runtime imports to both endpoints")
        }
        // A receive endpoint may itself be the composition root when it owns
        // construction. The observable runtime import is sufficient for this
        // narrow structural adapter, but it does not generalize to DI semantics.
        return hasImport(codeSnapshot, edge.receive.path, edge.emit.path, { runtime: true })
            ? proven("receive endpoint has a runtime import to the emit endpoint")
            : contradicted("no assembly artifact and receive does not import emit at runtime")
    }
    if (kind === "event" || kind === "callback") {
        if (!edge.contract || !endpointPresent(edge.contract, presentArtifacts))
            return contradicted(`${kind} contract artifact is absent`)
        if (
            !hasImport(codeSnapshot, edge.emit.path, edge.contract.path) ||
            !hasImport(codeSnapshot, edge.receive.path, edge.contract.path)
        ) {
            return contradicted(`both endpoints do not reference the ${kind} contract`)
        }
        return unverifiable(
            `contract references exist, but generic syntax facts cannot prove ${kind} registration, publication or delivery`,
        )
    }
    if (kind === "rpc") {
        if (!edge.rpc?.service || !edge.rpc?.method) return contradicted("rpc service and method are required")
        const service = codeSnapshot.protoServices.find((candidate) => candidate.fullName === edge.rpc.service)
        if (!service?.methods?.some((method) => method.name === edge.rpc.method)) {
            return contradicted("canonical Proto service or method is absent")
        }
        return unverifiable(
            "canonical Proto method exists, but endpoint-to-generated-client/server wiring is not proven by the available facts",
        )
    }
    return unverifiable(`unsupported proof adapter ${kind || "missing"}`)
}

export function classifyArtifactSymbol({ artifact, codeSnapshot }) {
    if (!artifact?.symbol) return proofResult("proven", "tree-sitter-declaration", "artifact has no symbol constraint")
    if (!languageForPath(artifact.path)) {
        return proofResult("unverifiable", "tree-sitter-declaration", `no enabled Tree-sitter language for ${artifact.path}`)
    }
    const artifactPath = canonicalPath(artifact.path)
    const facts = codeSnapshot.treeSitterFacts ?? []
    const declarations = facts.filter(
        (fact) =>
            canonicalPath(fact.path) === artifactPath &&
            fact.category === "declarations" &&
            (fact.capture === "name" || fact.capture.startsWith("name.")),
    )
    if (declarations.some((fact) => fact.text === artifact.symbol)) {
        return proofResult("proven", "tree-sitter-declaration", `declaration fact captures ${artifact.symbol}`)
    }
    return proofResult(
        "unverifiable",
        "tree-sitter-declaration",
        declarations.length === 0
            ? `no declaration-name facts were available for ${artifact.path}`
            : `available declaration queries did not capture ${artifact.symbol}; absence is not proof that the symbol is missing`,
    )
}

function normalizedBoundary(boundary) {
    return {
        path: canonicalPath(boundary.path),
        kind: boundary.kind || "whole_file",
        selector: normalizeArchitectureIdentity(boundary.selector),
    }
}

export function boundaryRelation(left, right) {
    const a = normalizedBoundary(left)
    const b = normalizedBoundary(right)
    if (a.path !== b.path) return { relation: "disjoint", reason: "different paths" }
    if (!COMPUTABLE_BOUNDARIES.has(a.kind) || !COMPUTABLE_BOUNDARIES.has(b.kind)) {
        return { relation: "unknown", reason: `${a.kind}/${b.kind} has no stable containment rule` }
    }
    if (a.kind === "whole_file" || b.kind === "whole_file")
        return { relation: "overlap", reason: "whole_file contains the other boundary" }
    if (a.kind === "module" || b.kind === "module")
        return { relation: "overlap", reason: "module contains symbols in the same file" }
    if (!a.selector || !b.selector) return { relation: "unknown", reason: "symbol selector is missing" }
    return a.selector === b.selector
        ? { relation: "overlap", reason: "same symbol" }
        : { relation: "disjoint", reason: "different symbols" }
}

export function findBoundaryConflicts(tasks) {
    const findings = []
    for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
            const left = tasks[leftIndex]
            const right = tasks[rightIndex]
            for (const leftBoundary of left.boundaries ?? []) {
                for (const rightBoundary of right.boundaries ?? []) {
                    const relation = boundaryRelation(leftBoundary, rightBoundary)
                    if (relation.relation === "disjoint") continue
                    const completed = left.status === COMPLETED && right.status === COMPLETED
                    findings.push(
                        finding(
                            relation.relation === "overlap" && completed ? "blocking" : "warning",
                            relation.relation === "overlap" ? "owned-boundary-overlap" : "owned-boundary-unverifiable",
                            `${left.taskId} and ${right.taskId} ${relation.relation === "overlap" ? "overlap" : "cannot be proven disjoint"} at ${leftBoundary.path}: ${relation.reason}`,
                            { task: `${left.taskId},${right.taskId}`, file: left.file ?? right.file ?? null },
                        ),
                    )
                }
            }
        }
    }
    return findings
}

export function findAuthorityConflicts(claims) {
    const findings = []
    const byFact = new Map()
    for (const claim of claims) {
        const fact = normalizeArchitectureIdentity(claim.fact)
        if (!fact) continue
        if (!byFact.has(fact)) byFact.set(fact, [])
        byFact.get(fact).push({ ...claim, canonicalFact: fact })
    }
    for (const group of byFact.values()) {
        const writers = new Set(group.map((claim) => canonicalPath(claim.writer)))
        if (writers.size <= 1) continue
        const completedWriters = new Set(
            group.filter((claim) => claim.status === COMPLETED).map((claim) => canonicalPath(claim.writer)),
        )
        const severity = completedWriters.size > 1 ? "blocking" : "warning"
        findings.push(
            finding(
                severity,
                "authority-writer-conflict",
                `canonical fact "${group[0].fact}" has different explicit writers: ${group.map((claim) => `${claim.taskId}:${claim.writer}`).join(", ")}`,
                { task: group.map((claim) => claim.taskId).join(","), file: group[0].file ?? null },
            ),
        )
    }
    return findings
}

function diagramArtifacts(diagram) {
    const records = []
    for (const [nodeId, artifacts] of diagram.artifacts ?? []) {
        for (const artifact of artifacts) records.push({ nodeId, artifact, diagram })
    }
    return records
}

function evidenceArtifacts(task, diagram) {
    if (!task.architectureEvidence || task.architectureEvidence.diagramId !== diagram.id) return []
    const records = []
    for (const [nodeId, node] of task.architectureEvidence.nodes) {
        for (const artifact of node.artifacts) records.push({ nodeId, artifact, diagram })
    }
    return records
}

function artifactState(artifact, codeSnapshot, repoRoot) {
    const absolute = path.resolve(repoRoot, artifact.path)
    const exists = fs.existsSync(absolute)
    if (artifact.expectation !== "generated") return exists ? "present" : "absent"
    const generated = codeSnapshot.generated.find((record) => canonicalPath(record.path) === canonicalPath(artifact.path))
    if (!generated || generated.state !== "present") return "absent"
    if (artifact.canonicalSource && canonicalPath(generated.canonicalSource) !== canonicalPath(artifact.canonicalSource)) {
        return "generated-provenance-mismatch"
    }
    return "generated"
}

function expectationMatches(expectation, state) {
    return expectation === state
}

function treeSitterImport(edge) {
    const runtime = edge.classification === "runtime" || edge.classification === "mixed"
    return Object.freeze({
        importer: edge.importer,
        importerAbsolute: null,
        project: "tree-sitter",
        specifier: edge.specifier,
        kind: "tree_sitter_import",
        classification: edge.classification,
        typeOnly: !runtime,
        bindings: Object.freeze([]),
        line: edge.line,
        target:
            edge.target.kind === "workspace"
                ? Object.freeze({ kind: "workspace", path: edge.target.path, absolute: null, project: "tree-sitter" })
                : edge.target.kind === "external"
                  ? Object.freeze({ kind: "package", packageName: edge.specifier })
                  : Object.freeze({ kind: "unresolved" }),
    })
}

async function buildBoundedSnapshot({ repoRoot, artifactPaths, generatedArtifacts }) {
    const base = createCodeFactSnapshot({ repoRoot, sourceRoots: [], generatedArtifacts })
    const seeds = [...artifactPaths.values()]
        .map((artifactPath) => path.resolve(repoRoot, artifactPath))
        .filter((absolute) => languageForPath(absolute) && fs.existsSync(absolute) && fs.statSync(absolute).isFile())
    if (seeds.length === 0) return base
    const closure = await buildDependencyClosure({ repoRoot, seeds })
    return Object.freeze({
        ...base,
        imports: Object.freeze(closure.imports.map(treeSitterImport)),
        treeSitterFacts: closure.facts,
        couplingSccs: closure.runtimeSccs,
        diagnostics: Object.freeze([
            ...base.diagnostics,
            ...closure.diagnostics.map((entry) => Object.freeze({ provider: "tree-sitter", ...entry })),
        ]),
    })
}

function declaredRelations(taskEntries) {
    const relations = new Set()
    for (const entry of taskEntries) {
        const evidence = entry.task.architectureEvidence
        if (evidence) {
            for (const edge of evidence.edges) {
                if (!edge.emit?.path || !edge.receive?.path) continue
                if (edge.kind === "direct_import") {
                    relations.add(`${canonicalPath(edge.emit.path)}->${canonicalPath(edge.receive.path)}`)
                } else if (edge.kind === "composition") {
                    if (edge.assembly?.path) {
                        relations.add(`${canonicalPath(edge.assembly.path)}->${canonicalPath(edge.emit.path)}`)
                        relations.add(`${canonicalPath(edge.assembly.path)}->${canonicalPath(edge.receive.path)}`)
                    } else {
                        relations.add(`${canonicalPath(edge.receive.path)}->${canonicalPath(edge.emit.path)}`)
                    }
                } else if (["injected_port", "event", "callback"].includes(edge.kind) && edge.contract?.path) {
                    relations.add(`${canonicalPath(edge.emit.path)}->${canonicalPath(edge.contract.path)}`)
                    relations.add(`${canonicalPath(edge.receive.path)}->${canonicalPath(edge.contract.path)}`)
                }
            }
        }
        for (const owned of entry.task.owns) {
            for (const read of entry.task.reads) {
                relations.add(`${canonicalPath(owned.path)}->${canonicalPath(read.path)}`)
            }
        }
        for (const parsed of entry.task.diagrams) {
            if (parsed.problems.length > 0 || parsed.diagram.ignored) continue
            const diagram = parsed.diagram
            for (const edge of diagram.edges) {
                if (edge.style !== "solid") continue
                const fromArtifacts = diagram.artifacts.get(edge.from) ?? []
                const toArtifacts = diagram.artifacts.get(edge.to) ?? []
                for (const from of fromArtifacts) {
                    for (const to of toArtifacts) relations.add(`${canonicalPath(from.path)}->${canonicalPath(to.path)}`)
                }
            }
        }
    }
    return relations
}

function directRuntimeContracts(taskEntries) {
    const contracts = []
    for (const { task, status } of taskEntries) {
        for (const edge of task.architectureEvidence?.edges ?? []) {
            if (edge.kind !== "direct_import" || !edge.emit?.path || !edge.receive?.path) continue
            contracts.push({
                taskId: task.id,
                status,
                from: canonicalPath(edge.emit.path),
                to: canonicalPath(edge.receive.path),
                file: task.planPath,
                edgeId: edge.id,
            })
        }
    }
    return contracts
}

function runtimeComponents(outgoing) {
    let index = 0
    const indices = new Map()
    const lowLinks = new Map()
    const stack = []
    const onStack = new Set()
    const components = []
    const visit = (node) => {
        indices.set(node, index)
        lowLinks.set(node, index)
        index += 1
        stack.push(node)
        onStack.add(node)
        for (const target of outgoing.get(node) ?? []) {
            if (!indices.has(target)) {
                visit(target)
                lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)))
            } else if (onStack.has(target)) {
                lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)))
            }
        }
        if (lowLinks.get(node) !== indices.get(node)) return
        const component = []
        for (;;) {
            const member = stack.pop()
            onStack.delete(member)
            component.push(member)
            if (member === node) break
        }
        components.push(component)
    }
    for (const node of outgoing.keys()) if (!indices.has(node)) visit(node)
    return components
}

function runtimeContradictionFindings({ codeSnapshot, artifactPaths, tasksByPath, taskStatusById, contracts }) {
    const findings = []
    for (const contract of contracts) {
        const reverse = codeSnapshot.imports.find(
            (edge) => !edge.typeOnly && canonicalPath(edge.importer) === contract.to && importTargets(edge, contract.from),
        )
        if (!reverse) continue
        findings.push(
            finding(
                contract.status === COMPLETED ? "blocking" : "warning",
                "runtime-edge-direction-contradiction",
                `runtime edge ${reverse.importer} -> ${contract.from} reverses direct-import evidence ${contract.edgeId}`,
                { task: contract.taskId, file: reverse.importer, line: reverse.line },
            ),
        )
    }

    const outgoing = new Map()
    for (const edge of codeSnapshot.imports) {
        if (edge.typeOnly || edge.target.kind !== "workspace") continue
        const from = canonicalPath(edge.importer)
        const to = canonicalPath(edge.target.path)
        if (!artifactPaths.has(from) || !artifactPaths.has(to)) continue
        if (!outgoing.has(from)) outgoing.set(from, new Set())
        if (!outgoing.has(to)) outgoing.set(to, new Set())
        outgoing.get(from).add(to)
    }
    for (const component of runtimeComponents(outgoing)) {
        const members = new Set(component)
        const hasCycle = component.length > 1 || [...(outgoing.get(component[0]) ?? [])].some((target) => target === component[0])
        if (!hasCycle) continue
        const taskIds = [...new Set(component.map((member) => tasksByPath.get(member)).filter(Boolean))].sort()
        const completed = taskIds.length > 0 && taskIds.every((taskId) => taskStatusById.get(taskId) === COMPLETED)
        findings.push(
            finding(
                completed ? "blocking" : "warning",
                "runtime-scc",
                `bounded runtime import graph forms SCC ${component.slice().sort().join(" -> ")}; type-only edges are excluded`,
                { task: taskIds.join(",") || null },
            ),
        )
    }
    return findings
}

function actualEdgeFindings({ codeSnapshot, artifactPaths, declared, tasksByPath }) {
    const findings = []
    let externalCount = 0
    for (const edge of codeSnapshot.imports) {
        const importer = canonicalPath(edge.importer)
        if (!artifactPaths.has(importer)) continue
        if (edge.target.kind === "package" || edge.target.kind === "builtin") {
            externalCount += 1
            continue
        }
        if (edge.target.kind !== "workspace") continue
        const target = canonicalPath(edge.target.path)
        if (declared.has(`${importer}->${target}`)) continue
        const task = tasksByPath.get(importer) ?? null
        findings.push(
            finding(
                "warning",
                artifactPaths.has(target) ? "actual-edge-undeclared" : "actual-edge-outbound-boundary",
                `${edge.typeOnly ? "type-only" : "runtime"} edge ${edge.importer} -> ${edge.target.path} has no diagram/read/evidence counterpart`,
                { task, file: edge.importer, line: edge.line },
            ),
        )
    }
    if (externalCount > 0) {
        findings.push(
            finding(
                "not-checked",
                "external-package-edges",
                `${externalCount} external package/builtin edge(s) were classified but are outside current-Workstream diagram conformance`,
            ),
        )
    }
    return findings
}

function dedupe(findings) {
    const seen = new Set()
    return findings.filter((entry) => {
        const key = [entry.severity, entry.rule, entry.task, entry.file, entry.line, entry.message].join("|")
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

export async function checkCodeConformance(context) {
    const findings = []
    const taskEntries = [...context.tasks.values()].map((task) => ({ task, status: task.status ?? "unknown" }))
    const taskStatusById = new Map(taskEntries.map(({ task, status }) => [task.id, status]))
    const artifactRecords = []
    // Comparison keys are case-normalized, but filesystem reads retain the
    // declared spelling so Linux checkouts remain valid.
    const artifactPaths = new Map()
    const addArtifactPath = (artifactPath) => {
        if (!artifactPath) return
        const key = canonicalPath(artifactPath)
        if (!artifactPaths.has(key)) artifactPaths.set(key, artifactPath)
    }
    const tasksByPath = new Map()
    const authorityClaims = []
    const edgeEvidence = []
    const edgeIds = new Map()
    const evidenceArtifactIds = new Map()

    for (const parsed of context.spec.diagrams) {
        if (parsed.problems.length > 0 || parsed.diagram.ignored) continue
        findings.push(...(parsed.diagram.annotationFindings ?? []))
        for (const record of diagramArtifacts(parsed.diagram)) {
            artifactRecords.push({ ...record, task: null, status: "unknown" })
            addArtifactPath(record.artifact.path)
        }
    }

    for (const { task, status } of taskEntries) {
        for (const boundary of [...task.owns, ...task.reads]) {
            addArtifactPath(boundary.path)
            if (!tasksByPath.has(canonicalPath(boundary.path))) tasksByPath.set(canonicalPath(boundary.path), task.id)
        }
        for (const evidenceProblem of task.evidenceProblems ?? []) {
            findings.push(
                finding(classifyExpectationMismatch(status), evidenceProblem.rule, evidenceProblem.message, {
                    task: task.id,
                    file: evidenceProblem.file,
                    line: evidenceProblem.line,
                    attribution: "record",
                }),
            )
        }
        for (const [artifactId] of task.architectureEvidence?.artifactById ?? []) {
            const existing = evidenceArtifactIds.get(artifactId)
            if (existing) {
                findings.push(
                    finding(
                        status === COMPLETED && existing.status === COMPLETED ? "blocking" : "warning",
                        "evidence-artifact-id-duplicate",
                        `artifact evidence id ${artifactId} is used by both ${existing.task.id} and ${task.id}`,
                        { task: task.id, file: task.planPath, attribution: "record" },
                    ),
                )
            } else {
                evidenceArtifactIds.set(artifactId, { task, status })
            }
        }
        for (const parsed of task.diagrams) {
            if (parsed.problems.length > 0 || parsed.diagram.ignored) continue
            const diagram = parsed.diagram
            findings.push(...(diagram.annotationFindings ?? []).map((entry) => ({ ...entry, task: task.id, diagram: task.id })))
            const records = [...diagramArtifacts(diagram), ...evidenceArtifacts(task, diagram)]
            for (const record of records) {
                artifactRecords.push({ ...record, task, status })
                const artifactPath = canonicalPath(record.artifact.path)
                if (artifactPath) {
                    addArtifactPath(record.artifact.path)
                    if (!tasksByPath.has(artifactPath)) tasksByPath.set(artifactPath, task.id)
                }
                if (record.artifact.role === "writer") {
                    authorityClaims.push({
                        taskId: task.id,
                        status,
                        fact: canonicalNodeKey(diagram, record.nodeId),
                        writer: `${record.artifact.path}${record.artifact.symbol ? `#${record.artifact.symbol}` : ""}`,
                        file: diagram.file,
                    })
                }
            }
            if (task.architectureEvidence?.diagramId === diagram.id) {
                for (const validation of validateEvidenceAgainstDiagram(task.architectureEvidence, diagram)) {
                    findings.push(
                        finding(classifyExpectationMismatch(status), validation.rule, validation.message, {
                            task: task.id,
                            file: validation.file,
                            line: validation.line,
                            attribution: "record",
                        }),
                    )
                }
                for (const edge of task.architectureEvidence.edges) {
                    edgeEvidence.push({ task, status, edge, diagram })
                    if (edge.id) {
                        if (edgeIds.has(edge.id)) {
                            findings.push(
                                finding(
                                    status === COMPLETED && edgeIds.get(edge.id).status === COMPLETED ? "blocking" : "warning",
                                    "evidence-edge-id-duplicate",
                                    `edge evidence id ${edge.id} is used by both ${edgeIds.get(edge.id).task.id} and ${task.id}`,
                                    { task: task.id, file: task.planPath, attribution: "record" },
                                ),
                            )
                        } else edgeIds.set(edge.id, { task, status })
                    }
                    for (const endpoint of [edge.emit, edge.receive, edge.contract, edge.assembly]) {
                        addArtifactPath(endpoint?.path)
                    }
                }
            }
        }
    }

    const generatedArtifacts = artifactRecords
        .filter((record) => record.artifact.expectation === "generated" || record.artifact.role === "generated")
        .map((record) => ({
            path: record.artifact.path,
            kind: "bound-generated",
            generator: record.artifact.provenance ?? "architecture-evidence",
            sourceRoot: record.artifact.canonicalSource
                ? path.posix.dirname(record.artifact.canonicalSource.replaceAll("\\", "/"))
                : "proto",
        }))
    const codeSnapshot =
        context.codeSnapshot ??
        (await buildBoundedSnapshot({
            repoRoot: context.repoRoot,
            artifactPaths,
            generatedArtifacts,
        }))
    const presentArtifacts = new Set(
        [...artifactPaths.entries()]
            .filter(([, declaredPath]) => fs.existsSync(path.resolve(context.repoRoot, declaredPath)))
            .map(([canonical]) => canonical),
    )

    for (const diagnostic of codeSnapshot.diagnostics) {
        findings.push(
            finding("warning", "code-fact-diagnostic", `${diagnostic.provider}: ${diagnostic.message}`, {
                file: diagnostic.file ?? null,
                line: diagnostic.line ?? null,
            }),
        )
    }

    for (const record of artifactRecords) {
        const artifact = record.artifact
        if (!artifact.path || !["present", "absent", "generated"].includes(artifact.expectation)) continue
        const state = artifactState(artifact, codeSnapshot, context.repoRoot)
        if (!expectationMatches(artifact.expectation, state)) {
            findings.push(
                finding(
                    classifyExpectationMismatch(record.status),
                    "artifact-expectation-mismatch",
                    `${artifact.path}${artifact.symbol ? `#${artifact.symbol}` : ""} expected ${artifact.expectation} but is ${state}`,
                    { task: record.task?.id ?? null, file: record.diagram.file, line: artifact.line ?? null },
                ),
            )
            continue
        }
        if (artifact.role === "declaration" && artifact.symbol && artifact.expectation === "present") {
            const symbolProof = classifyArtifactSymbol({ artifact, codeSnapshot })
            if (symbolProof.status !== "proven") {
                findings.push(
                    finding(
                        record.status === COMPLETED ? "unverifiable" : "warning",
                        "artifact-symbol-unverifiable",
                        `${artifact.path}#${artifact.symbol} is unverifiable: ${symbolProof.reason}`,
                        { task: record.task?.id ?? null, file: record.diagram.file, line: artifact.line ?? null },
                    ),
                )
            }
        }
    }

    for (const { task, edge } of edgeEvidence) {
        if (!edge.emit || !edge.receive || edge.proof.length === 0) {
            findings.push(
                finding(
                    "warning",
                    "edge-evidence-incomplete",
                    `edge ${edge.id || `${edge.from}->${edge.to}`} lacks emit, receive or proof`,
                    {
                        task: task.id,
                        file: task.planPath,
                        attribution: "record",
                    },
                ),
            )
        }
        for (const proofId of edge.proof) {
            if (!task.requiredVerification.has(proofId)) {
                findings.push(
                    finding(
                        classifyExpectationMismatch(task.status),
                        "edge-proof-unknown",
                        `edge ${edge.id} references undeclared verification ${proofId}`,
                        {
                            task: task.id,
                            file: task.planPath,
                            attribution: "record",
                        },
                    ),
                )
            }
        }
        const proof = proveEvidenceEdge({ edge, codeSnapshot, presentArtifacts })
        if (proof.status === "unverifiable") {
            findings.push(
                finding(
                    "unverifiable",
                    "edge-wiring-unverifiable",
                    `edge ${edge.id || `${edge.from}->${edge.to}`} (${proof.adapter || "unknown"}) is unverifiable: ${proof.reason}`,
                    {
                        task: task.id,
                        file: task.planPath,
                    },
                ),
            )
        } else if (proof.status === "contradicted") {
            findings.push(
                finding(
                    classifyExpectationMismatch(task.status),
                    "edge-wiring-contradiction",
                    `edge ${edge.id || `${edge.from}->${edge.to}`} (${proof.adapter || "unknown"}) contradicts code facts: ${proof.reason}`,
                    {
                        task: task.id,
                        file: task.planPath,
                    },
                ),
            )
        }
    }

    findings.push(...findAuthorityConflicts(authorityClaims))
    findings.push(
        ...findBoundaryConflicts(
            taskEntries.map(({ task, status }) => ({
                taskId: task.id,
                status,
                boundaries: task.owns,
                file: task.goalsPath,
            })),
        ),
    )

    findings.push(
        ...runtimeContradictionFindings({
            codeSnapshot,
            artifactPaths,
            tasksByPath,
            taskStatusById,
            contracts: directRuntimeContracts(taskEntries),
        }),
    )
    const declared = declaredRelations(taskEntries)
    findings.push(...actualEdgeFindings({ codeSnapshot, artifactPaths, declared, tasksByPath }))
    return dedupe(findings)
}
