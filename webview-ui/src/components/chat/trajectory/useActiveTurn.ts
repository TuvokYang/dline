import { useMemo } from "react"
import type { TrajectoryAttempt } from "./trajectory-model"

/**
 * The anchor of the turn the reader is in: the last turn opened at or before
 * the top visible message. Above the first turn the first one is shown, so the
 * rail always marks a place once it has turns.
 *
 * `anchors` must be ascending, which the trajectory guarantees because turns
 * follow the chat order and ts is unique per message.
 */
export function activeTurnAnchor(anchors: readonly number[], topVisibleTs: number | undefined): number | undefined {
    if (anchors.length === 0 || topVisibleTs === undefined) return undefined
    let low = 0
    let high = anchors.length - 1
    let found = 0
    while (low <= high) {
        const middle = (low + high) >> 1
        if (anchors[middle] <= topVisibleTs) {
            found = middle
            low = middle + 1
        } else {
            high = middle - 1
        }
    }
    return anchors[found]
}

export function useActiveTurn(attempts: readonly TrajectoryAttempt[], topVisibleTs: number | undefined): number | undefined {
    const anchors = useMemo(() => attempts.flatMap((attempt) => attempt.turns.map((turn) => turn.anchorTs)), [attempts])
    return activeTurnAnchor(anchors, topVisibleTs)
}
