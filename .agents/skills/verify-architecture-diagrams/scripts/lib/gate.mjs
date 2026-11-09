// Inspection is read-only and may precede completion. A recorded blocker still
// prevents conformance; it must not prevent collecting the evidence to resolve it.

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

    const upstreamReady = pending.length === 0
    for (const reason of local.reasons) pending.push(reason)
    if (task.blockers.length > 0) pending.push(`blockers is not empty (${task.blockers.length})`)
    // Record contradictions are reported separately; they must not be read as gate postponement.
    const contradictions = []

    return {
        taskId: task.id,
        astAllowed: local.astAllowed && upstreamReady,
        readyForConformance: pending.length === 0,
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
