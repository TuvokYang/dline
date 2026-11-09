import { memo } from "react"
import { ConversationTrajectoryRail } from "./ConversationTrajectoryRail"
import type { TrajectoryTurn } from "./trajectory-model"
import { useActiveTurn } from "./useActiveTurn"
import { useTrajectory } from "./useTrajectory"
import { useTrajectoryRailViewport } from "./useTrajectoryRailViewport"

interface TrajectoryRailOverlayProps {
    taskId?: string
    taskInstanceId?: string
    /** The chat list's scroll element, used to locate its top message. */
    scroller: HTMLElement | null
    onSelectTurn: (turn: TrajectoryTurn) => void
}

/**
 * The trajectory rail bound to one opening and one chat list.
 *
 * Kept as its own component so trajectory updates and per-frame scroll reads
 * re-render the rail alone, never the chat list it is drawn over.
 */
export const TrajectoryRailOverlay = memo(function TrajectoryRailOverlay({
    taskId,
    taskInstanceId,
    scroller,
    onSelectTurn,
}: TrajectoryRailOverlayProps) {
    const attempts = useTrajectory(taskId, taskInstanceId)
    const { topVisibleIndex } = useTrajectoryRailViewport(scroller)
    const activeTurnSeq = useActiveTurn(attempts, topVisibleIndex)
    return <ConversationTrajectoryRail activeTurnSeq={activeTurnSeq} attempts={attempts} onSelectTurn={onSelectTurn} />
})
