// Gate: decide whether AST verification may run for a task.
// Every reason here is a postponement, never a defect, because a task that is
// planned, blocked, coordinating or unverified has not claimed implementation.

import { evaluateGates } from "./task-model.mjs"

export function evaluateTaskGate(task, planGraph, tasks) {
    const local = evaluateGates(task, planGraph)
    const pending = []

    for (const dependency of local.upstreamPending) {
        const upstream = tasks.get(dependency)
        if (!upstream) {
            pending.push(`depends on ${dependency}, which has no task directory`)
            continue
        }
        if (upstream.status !== "completed") {
            pending.push(`depends on ${dependency} (${upstream.status ?? "unknown"})`)
        }
        if (upstream.waitingFor.length > 0) {
            pending.push(`depends on ${dependency}, which is waiting for coordination`)
        }
    }

    for (const reason of local.reasons) pending.push(reason)
    // Record contradictions are reported separately; they must not be read as gate postponement.
    const contradictions = []

    return {
        taskId: task.id,
        astAllowed: pending.length === 0,
        reasons: dedupe(pending),
        contradictions,
        status: task.status,
    }
}

export function evaluateAllGates(tasks, planGraph) {
    const gates = new Map()
    for (const task of tasks.values()) {
        gates.set(task.id, evaluateTaskGate(task, planGraph, tasks))
    }
    return gates
}

function dedupe(items) {
    return [...new Set(items)]
}
