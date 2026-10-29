import { TrajectoryState, TrajectoryToolCount, TrajectoryTurnSummary, TrajectoryUpdate } from "@shared/proto/dline/task"

/** What a trajectory response reports about the cache behind it. */
export type TrajectoryFrameState = "ready" | "building" | "error" | "unavailable"

/** One turn as the trajectory stream sends it. */
export interface TrajectoryFrameTurn {
    readonly seq: number
    readonly attemptSeq: number
    readonly anchorTs: number
    readonly prompt: string
    readonly rounds: number
    readonly toolUsage: readonly { readonly tool: string; readonly count: number }[]
    readonly endsAttempt: boolean
    readonly tailTs: number
}

/**
 * One response of a trajectory stream before transport encoding.
 *
 * With `reset`, `turns` is the whole trajectory. Otherwise it holds the turns
 * written after `baseRevision`, which equals the revision of the previous
 * response; the receiver replaces turns by `seq`, then drops every turn at or
 * past `turnCount`.
 */
export interface TrajectoryFrame {
    readonly state: TrajectoryFrameState
    readonly revision: number
    readonly baseRevision: number
    readonly reset: boolean
    readonly turnCount: number
    readonly turns: readonly TrajectoryFrameTurn[]
}

/** The opening a response is addressed to, so a Webview can drop responses for another one. */
export interface TrajectoryFrameOpening {
    readonly taskId: string
    readonly taskInstanceId: string
}

const PROTO_STATES: Readonly<Record<TrajectoryFrameState, TrajectoryState>> = {
    ready: TrajectoryState.TRAJECTORY_STATE_READY,
    building: TrajectoryState.TRAJECTORY_STATE_BUILDING,
    error: TrajectoryState.TRAJECTORY_STATE_ERROR,
    unavailable: TrajectoryState.TRAJECTORY_STATE_UNAVAILABLE,
}

function turnToProto(turn: TrajectoryFrameTurn): TrajectoryTurnSummary {
    return TrajectoryTurnSummary.create({
        seq: turn.seq,
        attemptSeq: turn.attemptSeq,
        anchorTs: turn.anchorTs,
        prompt: turn.prompt,
        rounds: turn.rounds,
        toolUsage: turn.toolUsage.map((usage) => TrajectoryToolCount.create({ tool: usage.tool, count: usage.count })),
        endsAttempt: turn.endsAttempt,
        tailTs: turn.tailTs,
    })
}

export function trajectoryFrameToProto(frame: TrajectoryFrame, opening: TrajectoryFrameOpening): TrajectoryUpdate {
    return TrajectoryUpdate.create({
        taskId: opening.taskId,
        taskInstanceId: opening.taskInstanceId,
        state: PROTO_STATES[frame.state],
        revision: frame.revision,
        baseRevision: frame.baseRevision,
        reset: frame.reset,
        turnCount: frame.turnCount,
        turns: frame.turns.map(turnToProto),
    })
}

/** The frame a stream sends while its opening may not read the trajectory. */
export const UNAVAILABLE_TRAJECTORY_FRAME: TrajectoryFrame = Object.freeze({
    state: "unavailable",
    revision: 0,
    baseRevision: 0,
    reset: true,
    turnCount: 0,
    turns: [],
})
