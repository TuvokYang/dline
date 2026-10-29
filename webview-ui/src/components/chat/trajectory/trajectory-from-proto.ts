import { TrajectoryState, type TrajectoryTurnSummary, type TrajectoryUpdate } from "@shared/proto/dline/task"
import type { TrajectoryAttempt } from "./trajectory-model"

/** The trajectory as the client holds it: every turn by seq, at one revision of the stream. */
export interface TrajectoryLog {
    readonly state: TrajectoryState
    readonly revision: number
    /** Indexed by seq, which the extension assigns densely from 0. */
    readonly turns: readonly TrajectoryTurnSummary[]
}

/** A delta that does not follow the held revision; only a fresh reset can repair the log. */
export const TRAJECTORY_GAP = "gap"

/**
 * Apply one stream response to the held log.
 *
 * A reset replaces the log. A delta applies only on top of the revision it was
 * computed from; anything else means a response was missed and the caller must
 * resubscribe, whose first response is always a reset.
 */
export function applyTrajectoryUpdate(
    log: TrajectoryLog | undefined,
    update: TrajectoryUpdate,
): TrajectoryLog | typeof TRAJECTORY_GAP {
    if (update.reset) return { state: update.state, revision: update.revision, turns: placeBySeq([], update) }
    if (!log || update.baseRevision !== log.revision) return TRAJECTORY_GAP
    return { state: update.state, revision: update.revision, turns: placeBySeq(log.turns, update) }
}

function placeBySeq(held: readonly TrajectoryTurnSummary[], update: TrajectoryUpdate): TrajectoryTurnSummary[] {
    const turns = held.slice(0, update.turnCount)
    for (const turn of update.turns) if (turn.seq < update.turnCount) turns[turn.seq] = turn
    // A seq the stream never sent leaves a hole; keep only the run before it so no stale turn shows.
    let contiguous = 0
    while (contiguous < turns.length && turns[contiguous] !== undefined) contiguous++
    return turns.slice(0, contiguous)
}

/** Whether the rail has anything trustworthy to show for this log. */
export function isTrajectoryShown(log: TrajectoryLog | undefined): log is TrajectoryLog {
    return log?.state === TrajectoryState.TRAJECTORY_STATE_READY || log?.state === TrajectoryState.TRAJECTORY_STATE_BUILDING
}

/** Group turns into attempts: an attempt is the run of turns sharing an attemptSeq. */
export function toTrajectoryAttempts(turns: readonly TrajectoryTurnSummary[]): TrajectoryAttempt[] {
    const attempts: { attemptSeq: number; turns: TrajectoryAttempt["turns"][number][]; completed: boolean }[] = []
    for (const turn of turns) {
        let attempt = attempts.at(-1)
        if (!attempt || attempt.attemptSeq !== turn.attemptSeq) {
            attempt = { attemptSeq: turn.attemptSeq, turns: [], completed: false }
            attempts.push(attempt)
        }
        attempt.turns.push({
            anchorTs: turn.anchorTs,
            prompt: turn.prompt,
            rounds: turn.rounds,
            toolUsage: turn.toolUsage.map(({ tool, count }) => ({ tool, count })),
        })
        attempt.completed = turn.endsAttempt
    }
    return attempts.map(({ attemptSeq, turns, completed }) => ({ id: `attempt-${attemptSeq}`, turns, completed }))
}
