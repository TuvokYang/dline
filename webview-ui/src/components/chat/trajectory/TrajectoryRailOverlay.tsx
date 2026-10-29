import { memo } from "react"
import { ConversationTrajectoryRail } from "./ConversationTrajectoryRail"
import { useActiveTurn } from "./useActiveTurn"
import { useTrajectory } from "./useTrajectory"
import { useTrajectoryRailViewport } from "./useTrajectoryRailViewport"

interface TrajectoryRailOverlayProps {
    taskId?: string
    taskInstanceId?: string
    /** The chat list's scroll element; the rail follows its scrolling and its top message. */
    scroller: HTMLElement | null
    onSelectTurn: (anchorTs: number) => void
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
    const { scrolling, topVisibleTs } = useTrajectoryRailViewport(scroller)
    const activeTurnTs = useActiveTurn(attempts, topVisibleTs)
    return (
        <ConversationTrajectoryRail
            activeTurnTs={activeTurnTs}
            attempts={attempts}
            onSelectTurn={onSelectTurn}
            visible={scrolling}
        />
    )
})
