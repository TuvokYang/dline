import { useMemo } from "react"
import type { TrajectoryAttempt, TrajectoryTurn } from "./trajectory-model"

/**
 * The seq of the user interval containing the visible committed source index.
 * Missing optional indices leave points intact, but cannot define an interval.
 * Source indices follow transcript order; timestamps are never compared.
 */
export function activeTurnSeq(
    turns: readonly Pick<TrajectoryTurn, "seq" | "anchorIndex">[],
    topVisibleIndex: number | undefined,
): number | undefined {
    if (topVisibleIndex === undefined) return undefined
    let active: number | undefined
    for (const turn of turns) {
        if (turn.anchorIndex === undefined) continue
        if (active === undefined) active = turn.seq
        if (turn.anchorIndex > topVisibleIndex) break
        active = turn.seq
    }
    return active
}

export function useActiveTurn(attempts: readonly TrajectoryAttempt[], topVisibleIndex: number | undefined): number | undefined {
    const turns = useMemo(() => attempts.flatMap((attempt) => attempt.turns), [attempts])
    return activeTurnSeq(turns, topVisibleIndex)
}
