#!/usr/bin/env node
// Diagram verifier entry point.
// It owns argument parsing, stage ordering, aggregation and the exit code.
// Every rule lives in one of the lib modules.

import fs from "node:fs"
import path from "node:path"

import { checkAstForTask, selfTestAst } from "./lib/checks-ast.mjs"
import { checkTaskAgainstWorkstream } from "./lib/checks-b2.mjs"
import { checkTaskHorizontally } from "./lib/checks-b3.mjs"
import { checkDependsOnReachability } from "./lib/checks-depends.mjs"
import { checkInterLevel, resolveNode } from "./lib/checks-interlevel.mjs"
import { checkCycles, checkIntraLayer } from "./lib/checks-intra.mjs"
import { evaluateAllGates } from "./lib/gate.mjs"
import { computeExitCode, renderJsonReport, renderTextReport } from "./lib/report.mjs"
import { findStaleProjections, readRootStatus, readWorkstreamStatus } from "./lib/status-model.mjs"
import { findRecordContradictions, readPlanGraph, readTasks } from "./lib/task-model.mjs"
import { readSpecModel } from "./lib/ws-model.mjs"

function parseArgs(argv) {
    // The mutation self-test runs by default: a verdict from an unsound verifier
    // is not evidence, so soundness is checked unless the caller opts out.
    const options = { scope: "workstream", json: false, selfTest: true }
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]
        switch (arg) {
            case "--workstream":
                options.workstream = argv[++index]
                break
            case "--scope":
                options.scope = argv[++index]
                break
            case "--json":
                options.json = true
                break
            case "--self-test":
                options.selfTest = true
                break
            case "--no-self-test":
                options.selfTest = false
                break
            case "--help":
            case "-h":
                options.help = true
                break
            default:
                options.problem = `unknown argument: ${arg}`
        }
    }
    return options
}

const USAGE = `Usage:
  verify-diagrams.mjs --workstream <dir> [--scope workstream|task:<TASK-ID>|cross-task]
                      [--json] [--no-self-test]

Exit codes:
  0  no blocking, unverifiable or tooling findings
  1  blocking or unverifiable findings
  2  tooling problem; the design verdict is withheld`

function toolingFinding(file, line, message, reproduce) {
    return {
        severity: "tooling",
        attribution: "tooling",
        stage: "0",
        file,
        line,
        rule: "tooling",
        message,
        reproduce,
    }
}

function ignoring(problems, diagram) {
    if (!diagram.ignored) return false
    const { owner, reason } = diagram.ignoreReason ?? {}
    if (!owner || !reason) {
        problems.push({
            severity: "blocking",
            attribution: "diagram",
            stage: "0",
            file: diagram.file,
            line: diagram.line,
            diagram: diagram.answers ?? diagram.layer,
            rule: "ignore-incomplete",
            message: "%% ignore: requires owner=<task> and reason=<why>",
        })
        return true
    }
    problems.push({
        severity: "not-checked",
        attribution: "diagram",
        stage: "0",
        file: diagram.file,
        line: diagram.line,
        diagram: diagram.answers ?? diagram.layer,
        rule: "ignored",
        message: `ignored by owner=${owner} reason=${reason}`,
    })
    return true
}

// Pairs each fine diagram with the coarser diagrams it refines. A declared
// `%% refines:` is authoritative and may name several diagrams; without it the
// verifier falls back to the single most-overlapping coarser diagram and marks
// the pair as inferred so its findings cannot block.
function refinementPairs(diagrams, findings) {
    const pairs = []
    const layered = diagrams.filter((diagram) => diagram.layer)
    const byId = new Map(layered.filter((diagram) => diagram.id).map((diagram) => [diagram.id, diagram]))
    for (const fine of layered) {
        if (fine.refines.length > 0) {
            const coarseSet = []
            for (const wanted of fine.refines) {
                const coarse = byId.get(wanted)
                if (!coarse) {
                    findings.push({
                        severity: "blocking",
                        attribution: "diagram",
                        stage: "3",
                        file: fine.file,
                        line: fine.line,
                        diagram: fine.id ?? fine.answers ?? fine.layer,
                        rule: "refines-unknown",
                        message: `%% refines: ${wanted} names no layered diagram with that %% id:`,
                    })
                    continue
                }
                coarseSet.push(coarse)
            }
            // A diagram that refines several coarser diagrams owes each node to
            // one of them, not to all of them: a node resolved in a sibling
            // coarse diagram is treated as local for the others.
            for (const coarse of coarseSet) {
                const allowedLocalNodes = new Set()
                for (const node of fine.nodes.values()) {
                    if (resolveNode(node, coarse, fine).node) continue
                    if (coarseSet.some((sibling) => sibling !== coarse && resolveNode(node, sibling, fine).node)) {
                        allowedLocalNodes.add(node.id)
                    }
                }
                pairs.push({ coarse, fine, declared: true, allowedLocalNodes })
            }
            continue
        }
        let best = null
        for (const candidate of layered) {
            if (candidate === fine) continue
            if (Number(candidate.layer.slice(1)) >= Number(fine.layer.slice(1))) continue
            let overlap = 0
            for (const node of fine.nodes.values()) {
                if (candidate.nodes.has(node.id)) overlap += 2
                else if ([...candidate.nodes.values()].some((other) => other.label === node.label)) overlap += 1
            }
            if (!best || overlap > best.overlap) best = { diagram: candidate, overlap }
        }
        if (best) pairs.push({ coarse: best.diagram, fine, declared: false })
    }
    return pairs
}

// One finding per condition across the set keeps the report readable: the
// defect is the habit, not the individual diagram.
function reportSetAnnotations(checked, findings) {
    const missingLayer = checked.filter((diagram) => !diagram.layer)
    if (missingLayer.length > 0) {
        findings.push({
            severity: "unverifiable",
            attribution: "diagram",
            stage: "0",
            file: missingLayer[0].file,
            line: missingLayer[0].line,
            diagram: null,
            rule: "layer-annotation-missing",
            message: `${missingLayer.length} of ${checked.length} diagram(s) have no %% layer: annotation, so inter-level refinement cannot be judged; first at line ${missingLayer[0].line}`,
        })
    }
    const missingKind = checked.filter((diagram) => !diagram.kind)
    if (missingKind.length > 0) {
        findings.push({
            severity: "not-checked",
            attribution: "diagram",
            stage: "0",
            file: missingKind[0].file,
            line: missingKind[0].line,
            diagram: null,
            rule: "kind-annotation-missing",
            message: `${missingKind.length} diagram(s) have no %% kind: annotation and were checked as structure; a protocol or state flow must declare %% kind: flow`,
        })
    }
    const missingId = checked.filter((diagram) => diagram.layer && !diagram.id)
    if (missingId.length > 0) {
        findings.push({
            severity: "not-checked",
            attribution: "diagram",
            stage: "0",
            file: missingId[0].file,
            line: missingId[0].line,
            diagram: null,
            rule: "id-annotation-missing",
            message: `${missingId.length} layered diagram(s) have no %% id:, so no other diagram can declare that it refines them`,
        })
    }
    const missingAnswers = checked.filter((diagram) => !diagram.answers)
    if (missingAnswers.length > 0) {
        findings.push({
            severity: "not-checked",
            attribution: "diagram",
            stage: "0",
            file: missingAnswers[0].file,
            line: missingAnswers[0].line,
            diagram: null,
            rule: "answers-annotation-missing",
            message: `${missingAnswers.length} diagram(s) have no %% answers: annotation, so the single question each owns is not recorded`,
        })
    }
    const inferred = checked.filter((diagram) => diagram.layer && diagram.layer !== "L0" && diagram.refines.length === 0)
    if (inferred.length > 0) {
        findings.push({
            severity: "not-checked",
            attribution: "diagram",
            stage: "3",
            file: inferred[0].file,
            line: inferred[0].line,
            diagram: null,
            rule: "refinement-undeclared",
            message: `${inferred.length} layered diagram(s) below L0 declare no %% refines:, so their refinement pairing is inferred by overlap and its findings are reported for review only`,
        })
    }
    const duplicateIds = new Map()
    for (const diagram of checked) {
        if (!diagram.id) continue
        duplicateIds.set(diagram.id, (duplicateIds.get(diagram.id) ?? 0) + 1)
    }
    for (const [id, count] of duplicateIds) {
        if (count <= 1) continue
        const first = checked.find((diagram) => diagram.id === id)
        findings.push({
            severity: "blocking",
            attribution: "diagram",
            stage: "0",
            file: first.file,
            line: first.line,
            diagram: id,
            rule: "id-duplicate",
            message: `%% id: ${id} is declared by ${count} diagrams; an identity must be unique in the set`,
        })
    }
}

function runWorkstreamScope({ spec, findings }) {
    for (const parsed of spec.diagrams) {
        for (const problem of parsed.problems) {
            findings.push(
                toolingFinding(
                    problem.file,
                    problem.line,
                    problem.message,
                    "the statement uses syntax outside the declared subset",
                ),
            )
        }
    }

    const checked = []
    for (const parsed of spec.diagrams) {
        if (parsed.problems.length > 0) continue
        if (ignoring(findings, parsed.diagram)) continue
        checked.push(parsed.diagram)
    }

    reportSetAnnotations(checked, findings)

    for (const diagram of checked) {
        findings.push(...checkCycles(diagram))
        findings.push(...checkIntraLayer(diagram, spec.labelVocabulary))
    }

    for (const { coarse, fine, declared, allowedLocalNodes } of refinementPairs(checked, findings)) {
        findings.push(...checkInterLevel(coarse, fine, { declared, allowedLocalNodes }))
    }
    return checked
}

function runTaskScope({ spec, tasks, gates, scopeTaskId, findings, repoRoot }) {
    const task = tasks.get(scopeTaskId)
    if (!task) {
        findings.push(toolingFinding(null, null, `task ${scopeTaskId} has no directory under tasks/`, "check the task id"))
        return null
    }

    for (const parsed of task.diagrams) {
        for (const problem of parsed.problems) {
            findings.push(
                toolingFinding(
                    problem.file,
                    problem.line,
                    problem.message,
                    "the statement uses syntax outside the declared subset",
                ),
            )
        }
    }

    const checked = []
    for (const parsed of task.diagrams) {
        if (parsed.problems.length > 0) continue
        if (ignoring(findings, parsed.diagram)) continue
        checked.push(parsed.diagram)
    }

    for (const diagram of checked) {
        findings.push(...checkCycles(diagram))
        findings.push(...checkIntraLayer(diagram, spec.labelVocabulary))
    }

    const wsDiagrams = spec.diagrams
        .filter((parsed) => parsed.problems.length === 0 && !parsed.diagram.ignored)
        .map((parsed) => parsed.diagram)

    for (const diagram of checked) {
        findings.push(
            ...checkTaskAgainstWorkstream({
                taskId: task.id,
                taskDiagram: diagram,
                wsDiagrams,
                labelVocabulary: spec.labelVocabulary,
                specText: spec.specText,
            }),
        )
    }

    const gate = gates.get(task.id)
    if (gate.astAllowed) {
        if (checked.length === 0) {
            findings.push({
                severity: "unverifiable",
                attribution: "diagram",
                stage: "6",
                file: task.planPath,
                line: null,
                diagram: task.id,
                rule: "no-task-diagram",
                message: `${task.id} is complete but has no readable architecture diagram, so implementation claims cannot be anchored`,
                task: task.id,
            })
        } else {
            findings.push(...checkAstForTask({ task: { ...task, diagrams: checked }, wsModules: spec.moduleTable, repoRoot }))
        }
    } else {
        findings.push({
            severity: "pending",
            attribution: "diagram",
            stage: "6",
            file: task.progressPath,
            line: task.statusLine,
            diagram: task.id,
            rule: "ast-postponed",
            message: `implementation checks postponed: ${gate.reasons.join("; ")}`,
            task: task.id,
        })
    }
    return task
}

function runCrossTaskScope({ spec, tasks, gates, planGraph, planPath, findings }) {
    const wsDiagrams = spec.diagrams
        .filter((parsed) => parsed.problems.length === 0 && !parsed.diagram.ignored)
        .map((parsed) => parsed.diagram)
    findings.push(...checkDependsOnReachability({ tasks, planGraph, wsDiagrams, planPath }))

    const entries = []
    for (const task of tasks.values()) {
        for (const parsed of task.diagrams) {
            if (parsed.problems.length > 0 || parsed.diagram.ignored) continue
            entries.push({ taskId: task.id, diagram: parsed.diagram })
        }
    }
    if (entries.length === 0) {
        findings.push({
            severity: "not-checked",
            attribution: "diagram",
            stage: "5",
            file: null,
            line: null,
            diagram: null,
            rule: "no-task-diagrams",
            message: "no task diagrams are available for horizontal comparison",
        })
        return
    }
    findings.push(...checkTaskHorizontally({ entries }))

    // A task that cannot run its own gate cannot support a horizontal claim either.
    for (const task of tasks.values()) {
        const gate = gates.get(task.id)
        if (gate.astAllowed) continue
        findings.push({
            severity: "pending",
            attribution: "diagram",
            stage: "5",
            file: task.progressPath,
            line: task.statusLine,
            diagram: task.id,
            rule: "horizontal-input-pending",
            message: `${task.id} participates in cross-task comparison while unfinished: ${gate.reasons.join("; ")}`,
            task: task.id,
        })
    }
}

function main() {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        process.stdout.write(`${USAGE}\n`)
        return 0
    }
    if (options.problem || !options.workstream) {
        process.stderr.write(`${options.problem ?? "missing --workstream"}\n\n${USAGE}\n`)
        return 2
    }

    const workstreamDir = path.resolve(process.cwd(), options.workstream)
    const repoRoot = process.cwd()
    const findings = []

    if (!fs.existsSync(workstreamDir)) {
        process.stderr.write(`workstream directory not found: ${options.workstream}\n`)
        return 2
    }

    const spec = readSpecModel(workstreamDir)
    if (spec.error) {
        findings.push(
            toolingFinding(spec.error.file, null, spec.error.message, "pass --workstream pointing at a Workstream directory"),
        )
        const summary = buildSummary({ options, spec: null, tasks: new Map(), gates: new Map(), findings, stale: [] })
        process.stdout.write(
            options.json ? `${renderJsonReport({ findings, summary })}\n` : `${renderTextReport({ findings, summary })}\n`,
        )
        return 2
    }

    if (!spec.labelVocabulary) {
        findings.push({
            severity: "unverifiable",
            attribution: "diagram",
            stage: "2",
            file: spec.specPath,
            line: null,
            diagram: null,
            rule: "label-vocabulary-missing",
            message: "spec does not declare the normative arrow-label sentence, so every solid label is unverifiable",
        })
    }

    const taskModel = readTasks(workstreamDir)
    for (const problem of taskModel.problems) {
        findings.push(
            toolingFinding(
                problem.file,
                null,
                problem.message,
                "the file uses YAML outside the supported subset; extend yaml-lite or fix the document",
            ),
        )
    }

    const planPath = path.join(workstreamDir, "plan.md")
    const planGraph = fs.existsSync(planPath)
        ? readPlanGraph(fs.readFileSync(planPath, "utf8"))
        : { tasks: [], error: "plan.md not found" }
    if (planGraph.error) {
        findings.push({
            severity: "not-checked",
            attribution: "diagram",
            stage: "6",
            file: path.relative(repoRoot, planPath),
            line: null,
            diagram: null,
            rule: "task-graph-missing",
            message: `${planGraph.error}; upstream dependency propagation is not verified`,
        })
    }

    const gates = evaluateAllGates(taskModel.tasks, planGraph)

    for (const task of taskModel.tasks.values()) {
        for (const contradiction of findRecordContradictions(task)) {
            findings.push({
                severity: "blocking",
                attribution: "record",
                stage: "6",
                file: contradiction.file,
                line: task.statusLine,
                diagram: task.id,
                rule: contradiction.rule,
                message: contradiction.message,
                task: task.id,
            })
        }
    }

    if (options.scope === "workstream") {
        runWorkstreamScope({ spec, findings })
    } else if (options.scope === "cross-task") {
        runCrossTaskScope({
            spec,
            tasks: taskModel.tasks,
            gates,
            planGraph,
            planPath: path.relative(repoRoot, planPath),
            findings,
        })
    } else if (options.scope.startsWith("task:")) {
        runTaskScope({
            spec,
            tasks: taskModel.tasks,
            gates,
            scopeTaskId: options.scope.slice("task:".length),
            findings,
            repoRoot,
        })
    } else {
        process.stderr.write(`unknown --scope value: ${options.scope}\n\n${USAGE}\n`)
        return 2
    }

    if (options.selfTest) {
        const result = selfTestAst(repoRoot)
        if (!result.ok) {
            findings.push(
                toolingFinding(
                    null,
                    null,
                    `AST mutation self-test failed: ${result.message}`,
                    "node .agents/skills/verify-architecture-diagrams/scripts/verify-diagrams.mjs --workstream <dir>",
                ),
            )
        } else {
            findings.push({
                severity: "not-checked",
                attribution: "diagram",
                stage: "6",
                file: null,
                line: null,
                diagram: null,
                rule: "self-test-passed",
                message: result.message,
            })
        }
    }

    const memoryBankRoot = path.resolve(workstreamDir, "..", "..")
    const stale = findStaleProjections(taskModel.tasks, readWorkstreamStatus(workstreamDir), readRootStatus(memoryBankRoot))

    const summary = buildSummary({ options, spec, tasks: taskModel.tasks, gates, findings, stale })
    summary.exitCode = computeExitCode(findings)

    process.stdout.write(
        options.json ? `${renderJsonReport({ findings, summary })}\n` : `${renderTextReport({ findings, summary })}\n`,
    )
    return summary.exitCode
}

function buildSummary({ options, spec, tasks, gates, findings, stale }) {
    const diagramCount = spec ? spec.diagrams.filter((parsed) => parsed.problems.length === 0).length : 0
    const taskDiagramCount = [...tasks.values()].reduce(
        (total, task) => total + task.diagrams.filter((parsed) => parsed.problems.length === 0).length,
        0,
    )
    return {
        workstream: options.workstream,
        scope: options.scope,
        diagramCount,
        taskDiagramCount,
        taskCount: tasks.size,
        astGatedCount: [...gates.values()].filter((gate) => gate.astAllowed).length,
        staleProjections: stale,
        exitCode: computeExitCode(findings),
    }
}

// A crash inside the verifier is a tooling problem, never a design verdict.
try {
    process.exitCode = main()
} catch (error) {
    process.stderr.write(
        [
            "## Tooling problem",
            `The verifier crashed and no design verdict could be produced: ${error?.message ?? String(error)}`,
            error?.stack ? `${error.stack}` : "",
            "Report this as a tool defect; do not read it as a passing or failing design result.",
            "",
        ].join("\n"),
    )
    process.exitCode = 2
}
