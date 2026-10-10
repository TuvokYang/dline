import { createInitialTaskState, type FlowPhase, type TaskState } from "../types"

export interface RunningTaskStateOptions {
    readonly taskId?: string
    readonly turnId?: string
    readonly revision?: number
    readonly phase?: FlowPhase
}

/**
 * Build one running kernel state for tests that observe a task without driving it.
 *
 * Telemetry and projection tests need a state that already has a turn identity
 * and a non-zero revision; producing it through the reducer would require a full
 * provider round and would couple those tests to turn-admission rules they are
 * not testing.
 */
export function createRunningTaskState(options: RunningTaskStateOptions = {}): TaskState {
    const taskId = options.taskId ?? "task-1"
    const revision = options.revision ?? 1
    const base = createInitialTaskState(taskId)
    return {
        ...base,
        revision,
        flow: { phase: options.phase ?? "running" },
        turn: { ...base.turn, turnId: options.turnId ?? "turn-a" },
        journalWatermark: { seq: revision },
    }
}
