/** What a kill_command row reports about the command it targeted. */
export type KillCommandPhase = "requested" | "terminating" | "terminated" | "already_finished" | "interrupted" | "not_running"

export interface KillCommandOutcome {
    phase: KillCommandPhase
    label: string
    /** The row is still waiting for the command to stop. */
    pending: boolean
}

const OUTCOMES: Record<KillCommandPhase, Omit<KillCommandOutcome, "phase">> = {
    requested: { label: "Dline requested command termination", pending: false },
    terminating: { label: "Terminating command…", pending: true },
    terminated: { label: "Command terminated", pending: false },
    already_finished: { label: "Command had already finished", pending: false },
    interrupted: { label: "Command was interrupted", pending: false },
    not_running: { label: "No running command matched", pending: false },
}

function phaseOf(activityId: string | undefined, status: string | undefined): KillCommandPhase {
    // The backend names the activity only when the function id matched a command.
    if (!activityId) return "not_running"
    switch (status) {
        case "awaiting_approval":
        case "running":
        case "cancelling":
            return "terminating"
        case "cancelled":
            return "terminated"
        case "completed":
        case "failed":
        case "timeout":
            return "already_finished"
        case "interrupted":
            return "interrupted"
        default:
            // The activity snapshot has not arrived yet.
            return "requested"
    }
}

/**
 * Project a kill_command row from the persisted status of the command activity
 * it targeted, so the row follows the command to its terminal state instead of
 * repeating the request.
 */
export function projectKillCommandOutcome(activityId: string | undefined, status: string | undefined): KillCommandOutcome {
    const phase = phaseOf(activityId, status)
    return { phase, ...OUTCOMES[phase] }
}
