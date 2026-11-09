import { useEffect, useState } from "react"
import { findFirstVisibleSourceRow } from "@/components/chat/chat-view/utils/viewportRowAnchor"

/**
 * How much of a message must show below the viewport top to count as read.
 *
 * A jump or a scroll often leaves a few pixels of the previous turn's last row
 * at the top edge; that sliver must not make the previous turn the current one.
 */
export const RAIL_READING_MIN_VISIBLE_PX = 8

/**
 * The source index of the topmost row in view. Grouped rows count, so a
 * tool group at the top still places the reader in its turn.
 *
 * The top message is read at most once per frame; scroll events fire far more
 * often than the rail can change.
 */
export function useTrajectoryRailViewport(scroller: HTMLElement | null): { topVisibleIndex?: number } {
    const [topVisibleIndex, setTopVisibleIndex] = useState<number>()

    useEffect(() => {
        if (!scroller) return
        let frame: number | undefined
        const readTop = () => {
            frame = undefined
            setTopVisibleIndex(findFirstVisibleSourceRow(scroller, { minVisiblePx: RAIL_READING_MIN_VISIBLE_PX })?.sourceIndex)
        }
        const onScroll = () => {
            frame ??= requestAnimationFrame(readTop)
        }
        frame = requestAnimationFrame(readTop)
        scroller.addEventListener("scroll", onScroll, { passive: true })
        return () => {
            scroller.removeEventListener("scroll", onScroll)
            if (frame !== undefined) cancelAnimationFrame(frame)
        }
    }, [scroller])

    return { topVisibleIndex }
}
