import type { Command, HaltSlice, ParticipantId, TaskEvent } from "../types"

export interface HaltReduction {
    readonly state: HaltSlice
    readonly commands: readonly Command[]
}
export const ALL_HALT_PARTICIPANTS: readonly ParticipantId[] = [
    "provider",
    "tool",
    "dialog",
    "compose",
    "compaction",
    "policy",
    "background",
    "cotask",
]

export function validateHaltEvent(
    state: HaltSlice,
    event: TaskEvent,
): { readonly reason: "duplicate" | "identity_mismatch"; readonly message: string } | undefined {
    if (event.type === "user.cancel")
        return state.status === "stopping"
            ? { reason: "duplicate", message: `Halt ${state.haltId} is already in progress` }
            : undefined
    // Termination is the explicit escalation path for a cancel that cannot reach
    // quiescence. The reducer records every participant that had not acknowledged
    // the active halt before advancing to the terminal state.
    if (event.type === "user.terminate") return undefined
    if (event.type !== "halt.halted" && event.type !== "halt.failed" && event.type !== "lifecycle.halt_timeout") return undefined
    if (state.status !== "stopping" || state.haltId !== event.haltId)
        return { reason: "identity_mismatch", message: `Halt ${event.haltId} is not active` }
    if (event.participantId && !state.pending.includes(event.participantId))
        return { reason: "duplicate", message: `${event.participantId} already acknowledged halt ${event.haltId}` }
    if (event.type === "lifecycle.halt_timeout" && event.participantId && state.timedOut.includes(event.participantId))
        return { reason: "duplicate", message: `${event.participantId} already timed out for halt ${event.haltId}` }
    return undefined
}

export function reduceHalt(state: HaltSlice, event: TaskEvent): HaltReduction {
    if (event.type === "user.cancel" || event.type === "user.terminate") {
        if (state.status === "stopping") {
            if (event.type === "user.cancel") return { state, commands: [] }
            return {
                state: {
                    ...state,
                    generation: state.generation + 1,
                    target: "terminated",
                    pending: [],
                    forcedClosed: state.pending,
                },
                commands: [],
            }
        }
        return {
            state: {
                status: "stopping",
                generation: state.generation + 1,
                haltId: event.haltId,
                target: event.type === "user.terminate" ? "terminated" : "paused",
                pending: ALL_HALT_PARTICIPANTS,
                halted: [],
                failed: [],
                timedOut: [],
            },
            commands: [],
        }
    }
    if (state.status !== "stopping") return { state, commands: [] }
    if (
        (event.type === "halt.halted" || event.type === "halt.failed") &&
        event.haltId === state.haltId &&
        state.pending.includes(event.participantId)
    ) {
        const pending = state.pending.filter((id) => id !== event.participantId)
        return {
            state: {
                ...state,
                pending,
                halted: event.type === "halt.halted" ? [...state.halted, event.participantId] : state.halted,
                failed: event.type === "halt.failed" ? [...state.failed, event.participantId] : state.failed,
            },
            commands: [],
        }
    }
    if (event.type === "lifecycle.halt_timeout" && event.haltId === state.haltId) {
        const timedOut = event.participantId
            ? state.timedOut.includes(event.participantId)
                ? state.timedOut
                : [...state.timedOut, event.participantId]
            : [...new Set([...state.timedOut, ...state.pending])]
        return { state: { ...state, timedOut }, commands: [] }
    }
    return { state, commands: [] }
}
