/**
 * View model of the conversation trajectory rail.
 *
 * A turn starts at one user message and owns the work the agent did until the
 * next user message. An attempt is the run of turns that ends at a completion
 * result; the user's reply to a completion opens the next attempt.
 */

/** How many times one turn called one tool. */
export interface TrajectoryToolUsage {
    /** Tool name as the chat labels it, such as `read_file`. */
    readonly tool: string
    readonly count: number
}

export interface TrajectoryTurn {
    /** Stream identity of this turn, independent of the message timestamp. */
    readonly seq: number
    /** Committed messages.db ordinal; neither a page coordinate nor a render-row offset. */
    readonly anchorIndex?: number
    /** Existing message identity, used only for equality when locating the source index. */
    readonly anchorTs: number
    readonly prompt: string
    /** Model request rounds the agent ran before the next user message. */
    readonly rounds: number
    /** Tool calls of the turn grouped by tool, most used first. */
    readonly toolUsage: readonly TrajectoryToolUsage[]
}

export interface TrajectoryAttempt {
    readonly id: string
    readonly turns: readonly TrajectoryTurn[]
    /** Whether the attempt ended at a completion result. */
    readonly completed: boolean
}
