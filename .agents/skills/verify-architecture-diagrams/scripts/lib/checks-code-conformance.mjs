// Stage 7: bounded comparison of diagram, task, evidence and canonical code facts.
// Diagram bindings define the inspected architectural boundary; Task reads are proof support.

import fs from "node:fs"
import path from "node:path"
import { createDiagramResolver, normalizeArchitectureIdentity } from "./architecture-identity.mjs"
import { createCodeFactSnapshot } from "./code-facts.mjs"
import { bindDiagramSources, expandDiagramSources } from "./diagram-sources.mjs"
import { validateEvidenceAgainstDiagram } from "./evidence-model.mjs"
import { counterpartAllows, declaredCounterparts, referenceParts, signalState } from "./reference-contracts.mjs"
import { importsInScriptRegions, resolveScriptRegion } from "./script-regions.mjs"
import { proveScriptWiring } from "./script-wiring.mjs"
import { buildDependencyClosure } from "./tree-sitter-dependencies.mjs"
import { languageForPath } from "./tree-sitter-runtime.mjs"

const COMPUTABLE_BOUNDARIES = new Set(["whole_file", "module", "symbol"])
const COMPLETED = "completed"
// A Task that has begun implementing is accountable for its actual dependency
// direction; a planned Task has no runtime of its own yet.
const IMPLEMENTED = new Set(["active", "blocked", COMPLETED])
const contradictionSeverity = (status) => (IMPLEMENTED.has(status) ? "blocking" : "warning")

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

function importTargets(edge, targetPath, { runtime = false } = {}) {
    const wanted = canonicalPath(targetPath)
    if (edge.target?.kind === "workspace" && canonicalPath(edge.target.path) === wanted) return true
    return (
        edge.bindings?.some((binding) => {
            const provenance = runtime ? binding.valueProvenance : binding.provenance
            return (
                (!runtime || !binding.typeOnly) &&
                provenance?.state === "resolved" &&
                provenance.declarations.some(
                    (declaration) => declaration.kind === "workspace" && canonicalPath(declaration.path) === wanted,
                )
            )
        }) ?? false
    )
}

// Every import statement that could carry this dependency, so a symbol claim can be
// checked against the identity it states rather than against the file alone.
function mateEdges(codeSnapshot, importer, target, { runtime = false } = {}) {
    const source = canonicalPath(importer)
    return codeSnapshot.imports.filter(
        (edge) =>
            canonicalPath(edge.importer) === source && (!runtime || !edge.typeOnly) && importTargets(edge, target, { runtime }),
    )
}

function hasImport(codeSnapshot, importer, target, { runtime = false } = {}) {
    return mateEdges(codeSnapshot, importer, target, { runtime }).length > 0
}

// Both endpoints of a direct_import name an identity, so importing the receive file is not
// the claim: the emitting boundary must import that exact symbol. An unresolved alias or
// barrel chain stays unverifiable instead of being read as a whole-file import.
function receiveIdentity(imports, importer, endpoint) {
    if (!endpoint?.symbol) return { state: "module" }
    const states = mateEdges({ imports }, importer, endpoint.path, { runtime: true }).map((edge) =>
        signalState(edge, endpoint.symbol, { path: endpoint.path, runtime: true }),
    )
    if (states.some((state) => state.state === "resolved")) return { state: "resolved" }
    if (states.some((state) => state.state === "unverifiable" || state.state === "type-only"))
        return {
            state: "unverifiable",
            reason: `${endpoint.path} is imported, but ${endpoint.symbol} cannot be resolved by import identity`,
        }
    return { state: "absent" }
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

    if (edge.contract && endpointPresent(edge.contract, presentArtifacts)) {
        const scriptProof = proveScriptWiring(edge, codeSnapshot)
        if (scriptProof) return scriptProof
    }
    if (kind === "direct_import") {
        let imports = codeSnapshot.imports
        if (edge.emit.symbol) {
            const entry = [...(codeSnapshot.scriptModels ?? [])].find(
                ([file]) => canonicalPath(file) === canonicalPath(edge.emit.path),
            )
            const selected = resolveScriptRegion(entry?.[1], { symbol: edge.emit.symbol })
            if (selected.state !== "resolved")
                return unverifiable("the exact emitting function cannot be resolved for its structural dependency")
            imports = importsInScriptRegions(codeSnapshot, entry[0], [selected])
        }
        if (!hasImport({ ...codeSnapshot, imports }, edge.emit.path, edge.receive.path, { runtime: true }))
            return contradicted("no runtime import within the declared emitting boundary connects emit to receive")
        // The receive endpoint is an identity, not only a file: an import of the module that
        // cannot carry that symbol is unproven, not proven.
        const identity = receiveIdentity(imports, edge.emit.path, edge.receive)
        if (identity.state === "unverifiable") return unverifiable(identity.reason)
        if (identity.state === "absent") return contradicted("no imported binding reaches the declared receive identity")
        return proven("runtime import used within the declared emitting boundary connects emit to receive")
    }
    if (kind === "injected_port") {
        if (!edge.contract || !endpointPresent(edge.contract, presentArtifacts))
            return contradicted("port contract artifact is absent")
        return unverifiable(
            "the contract artifact exists, but bounded syntax facts do not prove the concrete injection path or receiver identity",
        )
    }
    if (kind === "composition") {
        if (edge.assembly && !endpointPresent(edge.assembly, presentArtifacts))
            return contradicted("composition artifact is absent")
        // Importing both modules neither constructs them nor connects instances.
        return unverifiable(
            "runtime imports alone do not prove construction, injection or the identity of the composed instances",
        )
    }
    if (kind === "event" || kind === "callback") {
        if (!edge.contract || !endpointPresent(edge.contract, presentArtifacts))
            return contradicted(`${kind} contract artifact is absent`)
        return unverifiable(
            `the contract artifact exists, but bounded syntax facts do not prove ${kind} registration, publication or delivery through direct or contextual bindings`,
        )
    }
    if (kind === "rpc") {
        if (!edge.rpc?.service || !edge.rpc?.method) return contradicted("rpc service and method are required")
        const services = codeSnapshot.protoServices.filter((candidate) => candidate.fullName === edge.rpc.service)
        if (services.length === 0) return contradicted("canonical Proto service is absent")
        if (services.length !== 1) return unverifiable("canonical Proto service identity is ambiguous")
        const service = services[0]
        if (edge.contract?.path && canonicalPath(edge.contract.path) !== canonicalPath(service.file)) {
            return contradicted("RPC contract artifact is not the canonical service declaration file")
        }
        const methods = service.methods.filter((method) => method.name === edge.rpc.method)
        if (methods.length === 0) return contradicted("canonical Proto method is absent")
        if (methods.length !== 1) return unverifiable("canonical Proto method identity is ambiguous")
        const method = methods[0]
        if (method.requestIdentity?.state !== "resolved" || method.responseIdentity?.state !== "resolved") {
            return unverifiable("canonical RPC request/response message identity is unresolved or ambiguous")
        }
        return unverifiable(
            `canonical RPC ${service.fullName}.${method.name} resolves ${method.requestIdentity.fullName} -> ${method.responseIdentity.fullName}, but endpoint-to-generated-client/server delivery is not proven`,
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

function writerIdentity(writer) {
    const [file, ...symbol] = String(writer).split("#")
    return `${canonicalPath(file)}#${symbol.join("#")}`
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
        const writers = new Set(group.map((claim) => writerIdentity(claim.writer)))
        if (writers.size <= 1) continue
        const completedWriters = new Set(
            group.filter((claim) => claim.status === COMPLETED).map((claim) => writerIdentity(claim.writer)),
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
        bindings: edge.bindings ?? Object.freeze([]),
        line: edge.line,
        target:
            edge.target.kind === "workspace"
                ? Object.freeze({ kind: "workspace", path: edge.target.path, absolute: null, project: "tree-sitter" })
                : edge.target.kind === "external"
                  ? Object.freeze({ kind: "package", packageName: edge.specifier })
                  : Object.freeze({ kind: "unresolved" }),
    })
}

async function buildBoundedSnapshot({ repoRoot, artifactPaths, supportPaths, generatedArtifacts }) {
    const base = createCodeFactSnapshot({ repoRoot, sourceRoots: [], generatedArtifacts })
    const seeds = [...new Set([...artifactPaths.values(), ...supportPaths])]
        .map((artifactPath) => path.resolve(repoRoot, artifactPath))
        .filter((absolute) => languageForPath(absolute) && fs.existsSync(absolute) && fs.statSync(absolute).isFile())
    if (seeds.length === 0) return base
    // The bounded import closure supplies binding identities and cycle-closing interfaces.
    // Only bound subjects below become audit emitters; support files never do.
    const closure = await buildDependencyClosure({ repoRoot, seeds, followImports: true })
    return Object.freeze({
        ...base,
        imports: Object.freeze(closure.imports.map(treeSitterImport)),
        treeSitterFacts: closure.facts,
        scriptModels: closure.scriptModels,
        scriptModules: closure.scriptModules,
        couplingSccs: closure.runtimeSccs,
        diagnostics: Object.freeze([
            ...base.diagnostics,
            ...closure.diagnostics.map((entry) => Object.freeze({ provider: "tree-sitter", ...entry })),
        ]),
    })
}

// Every Task keeps its own counterparts: the emitting Task identity decides, and a
// shared file never inherits a sibling Task's diagram or evidence permission.
function declaredRelations(taskEntries) {
    const relations = new Map()
    for (const entry of taskEntries) relations.set(entry.task.id, declaredCounterparts(entry.task))
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

function runtimeContradictionFindings({
    codeSnapshot,
    artifactPaths,
    tasksByPath,
    taskStatusById,
    contracts,
    auditImports = null,
}) {
    const findings = []
    for (const contract of contracts) {
        const reverse = codeSnapshot.imports.find(
            (edge) => !edge.typeOnly && canonicalPath(edge.importer) === contract.to && importTargets(edge, contract.from),
        )
        if (!reverse) continue
        findings.push(
            finding(
                contradictionSeverity(contract.status),
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
        if (
            auditImports &&
            !auditImports.some(
                (edge) =>
                    !edge.typeOnly &&
                    edge.target.kind === "workspace" &&
                    members.has(canonicalPath(edge.importer)) &&
                    members.has(canonicalPath(edge.target.path)),
            )
        )
            continue
        const hasCycle = component.length > 1 || [...(outgoing.get(component[0]) ?? [])].some((target) => target === component[0])
        if (!hasCycle) continue
        const taskIds = [...new Set(component.map((member) => tasksByPath.get(member)).filter(Boolean))].sort()
        const implemented = taskIds.length > 0 && taskIds.every((taskId) => IMPLEMENTED.has(taskStatusById.get(taskId)))
        findings.push(
            finding(
                implemented ? "blocking" : "warning",
                "runtime-scc",
                `bounded runtime import graph forms SCC ${component.slice().sort().join(" -> ")}; type-only edges are excluded`,
                { task: taskIds.join(",") || null },
            ),
        )
    }
    return findings
}

function actualEdgeFindings({
    codeSnapshot,
    artifactPaths,
    declared,
    tasksByPath,
    tasks,
    taskStatusById,
    requireResolved = false,
}) {
    const findings = []
    let externalCount = 0
    for (const edge of codeSnapshot.imports.flatMap(referenceParts)) {
        const importer = canonicalPath(edge.importer)
        if (!artifactPaths.has(importer)) continue
        if (edge.target.kind === "package" || edge.target.kind === "builtin") {
            externalCount += 1
            continue
        }
        if (edge.target.kind !== "workspace") {
            if (requireResolved)
                findings.push(
                    finding(
                        "unverifiable",
                        "actual-edge-unresolved",
                        `in-scope import ${edge.importer} -> ${edge.specifier} has no resolved dependency identity`,
                        { task: edge.taskId ?? tasksByPath.get(importer), file: edge.importer, line: edge.line },
                    ),
                )
            continue
        }
        const target = canonicalPath(edge.target.path)
        const taskId = edge.taskId ?? tasksByPath.get(importer) ?? null
        const owner = tasks.get(taskId)
        // Reads provide inspection context, never import permission. Only this Task's
        // structural or evidence counterpart can authorize the emitting binding.
        const reference = { edge, importer, target }
        const permissions = (declared.get(taskId) ?? []).map((declaration) =>
            counterpartAllows(declaration, reference, { codeSnapshot }),
        )
        if (permissions.some((permission) => permission.state === "allowed")) continue
        // A contract that names this target but a different identity is not absence: the
        // reference stays unproven rather than becoming a silent default warning.
        const open = permissions.find((permission) => permission.state === "unverifiable")
        if (open) {
            findings.push(
                finding("unverifiable", "actual-edge-unverifiable", open.reason, {
                    task: taskId,
                    file: edge.importer,
                    line: edge.line,
                }),
            )
            continue
        }
        const bound = artifactPaths.has(target)
        const status = taskId ? (taskStatusById?.get(taskId) ?? owner?.status ?? null) : null
        findings.push(
            finding(
                contradictionSeverity(status),
                bound ? "actual-edge-undeclared" : "actual-edge-outbound-boundary",
                `${edge.typeOnly ? "type-only" : "runtime"} edge ${edge.importer} -> ${edge.target.path}${edge.bindings?.length ? ` (${edge.bindings.map((binding) => binding.imported).join(", ")})` : ""} has no diagram/evidence counterpart`,
                { task: taskId, file: edge.importer, line: edge.line },
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
    const validDiagrams = (parsed) =>
        parsed.filter((entry) => !entry.problems.length && !entry.diagram.ignored).map((entry) => entry.diagram)
    const resolver = createDiagramResolver(
        taskEntries.flatMap(({ task }) => validDiagrams(task.diagrams)),
        validDiagrams(context.spec.diagrams),
    )
    const supportPaths = new Set(taskEntries.flatMap(({ task }) => task.reads.map((read) => read.path)))
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
                        fact: resolver.keyOf(diagram, record.nodeId),
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

    // A code-only caller may provide explicit module boundaries without Mermaid bindings.
    // This compatibility path never interprets prose sections or changed-region records.
    if (artifactRecords.length === 0) {
        for (const { task, status } of taskEntries) {
            for (const owned of task.owns.filter((owned) => ["module", "whole_file"].includes(owned.kind))) {
                addArtifactPath(owned.path)
                if (!tasksByPath.has(canonicalPath(owned.path))) tasksByPath.set(canonicalPath(owned.path), task.id)
                artifactRecords.push({
                    artifact: { path: owned.path, expectation: "present", role: "declaration", symbol: null },
                    task,
                    status,
                    diagram: { file: task.planPath },
                })
            }
        }
    }
    const sourceRecords = expandDiagramSources(artifactRecords, context.repoRoot)
    for (const record of sourceRecords) addArtifactPath(record.artifact.path)
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
            supportPaths,
            generatedArtifacts,
        }))
    const presentArtifacts = new Set(
        [...artifactPaths.entries()]
            .filter(([, declaredPath]) => fs.existsSync(path.resolve(context.repoRoot, declaredPath)))
            .map(([canonical]) => canonical),
    )

    const bound = bindDiagramSources(sourceRecords, codeSnapshot, presentArtifacts)
    findings.push(...bound.findings)
    for (const diagnostic of codeSnapshot.diagnostics) {
        if ((diagnostic.path || diagnostic.file) && !artifactPaths.has(canonicalPath(diagnostic.path ?? diagnostic.file)))
            continue
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

    findings.push(...resolver.findings, ...findAuthorityConflicts(authorityClaims))
    findings.push(
        ...findBoundaryConflicts(
            taskEntries.map(({ task, status }) => ({
                taskId: task.id,
                status,
                boundaries: task.owns.filter((owned) =>
                    [...artifactPaths.values()].some(
                        (file) =>
                            canonicalPath(file) === canonicalPath(owned.path) ||
                            canonicalPath(file).startsWith(`${canonicalPath(owned.path).replace(/\/$/, "")}/`),
                    ),
                ),
                file: task.goalsPath,
            })),
        ),
    )

    const auditSnapshot = { ...codeSnapshot, imports: bound.imports }
    const proofPaths = new Map(artifactPaths)
    for (const edge of codeSnapshot.imports) {
        proofPaths.set(canonicalPath(edge.importer), edge.importer)
        if (edge.target.kind === "workspace") proofPaths.set(canonicalPath(edge.target.path), edge.target.path)
    }
    findings.push(
        ...runtimeContradictionFindings({
            codeSnapshot,
            artifactPaths: proofPaths,
            tasksByPath,
            taskStatusById,
            contracts: directRuntimeContracts(taskEntries),
            auditImports: auditSnapshot.imports,
        }),
    )
    const declared = declaredRelations(taskEntries)
    findings.push(
        ...actualEdgeFindings({
            codeSnapshot: auditSnapshot,
            artifactPaths,
            declared,
            tasksByPath,
            tasks: context.tasks,
            taskStatusById,
            requireResolved: true,
        }),
    )
    return dedupe(findings)
}
