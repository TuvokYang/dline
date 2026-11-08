import type { UiTranslator } from "@/i18n/messages"

/** What a kill_command row reports about the command it targeted. */
export type KillCommandPhase = "requested" | "terminating" | "terminated" | "already_finished" | "interrupted" | "not_running"

export interface KillCommandOutcome {
    phase: KillCommandPhase
    /** The row is still waiting for the command to stop. */
    pending: boolean
}

const OUTCOMES: Record<KillCommandPhase, Omit<KillCommandOutcome, "phase">> = {
    requested: { pending: false },
    terminating: { pending: true },
    terminated: { pending: false },
    already_finished: { pending: false },
    interrupted: { pending: false },
    not_running: { pending: false },
}

/** Message keys for each phase, resolved where the label is rendered. */
const PHASE_LABELS = {
    requested: "chatRows.kill.requested",
    terminating: "chatRows.kill.terminating",
    terminated: "chatRows.kill.terminated",
    already_finished: "chatRows.kill.alreadyFinished",
    interrupted: "chatRows.kill.interrupted",
    not_running: "chatRows.kill.notRunning",
} as const

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

/** Render the row label for an outcome in the surface's own language. */
export function killCommandLabel(outcome: KillCommandOutcome, t: UiTranslator): string {
    return t(PHASE_LABELS[outcome.phase])
}
