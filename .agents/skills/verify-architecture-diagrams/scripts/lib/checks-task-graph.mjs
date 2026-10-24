// Stage 5: validate the Workstream Task Graph as a DAG before relating it to diagrams.

import { stronglyConnectedComponents } from "./graph.mjs"

function finding(rule, message, planPath, row = null, task = null) {
    return {
        severity: "blocking",
        attribution: "diagram",
        stage: "5",
        file: planPath,
        line: row?.line ?? null,
        diagram: task,
        rule,
        message,
        task,
    }
}

export function checkTaskGraph(planGraph, planPath) {
    if (!planGraph || planGraph.error) return []
    const findings = []
    const ids = planGraph.tasks.map((row) => row.id)
    const known = new Set(ids)
    const seen = new Set()
    for (const row of planGraph.tasks) {
        if (seen.has(row.id)) {
            findings.push(finding("task-graph-duplicate", `Task Graph declares ${row.id} more than once`, planPath, row, row.id))
        }
        seen.add(row.id)
        if (!new Set(["serial", "parallel_when_ready"]).has(row.executionMode)) {
            findings.push(
                finding(
                    "task-execution-mode-invalid",
                    `${row.id} uses execution mode ${row.executionMode || "missing"}; expected serial or parallel_when_ready`,
                    planPath,
                    row,
                    row.id,
                ),
            )
        }
    }

    const edges = []
    for (const row of planGraph.tasks) {
        for (const dependency of row.dependsOn) {
            if (dependency.includes("/")) continue
            if (dependency === row.id) {
                findings.push(finding("task-dependency-self-loop", `${row.id} depends on itself`, planPath, row, row.id))
                continue
            }
            if (!known.has(dependency)) {
                findings.push(
                    finding("task-dependency-unknown", `${row.id} depends on unknown task ${dependency}`, planPath, row, row.id),
                )
                continue
            }
            edges.push({ from: dependency, to: row.id })
        }
    }
    const components = stronglyConnectedComponents([...known], edges).filter((component) => component.length > 1)
    for (const component of components) {
        const tasks = component.slice().sort()
        findings.push(
            finding(
                "task-dependency-cycle",
                `Task Graph contains dependency cycle across ${tasks.join(", ")}`,
                planPath,
                null,
                tasks.join(","),
            ),
        )
    }
    return findings
}
