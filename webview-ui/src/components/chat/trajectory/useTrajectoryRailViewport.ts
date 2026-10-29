import { useEffect, useState } from "react"
import { findFirstVisibleRow } from "@/components/chat/chat-view/utils/viewportRowAnchor"

/** How long the rail stays up after the last scroll event of a gesture. */
export const RAIL_SCROLL_IDLE_MS = 1_200

/**
 * How much of a message must show below the viewport top to count as read.
 *
 * A jump or a scroll often leaves a few pixels of the previous turn's last row
 * at the top edge; that sliver must not make the previous turn the current one.
 */
export const RAIL_READING_MIN_VISIBLE_PX = 8

/**
 * What the trajectory rail reads from the chat list: whether it is being
 * scrolled, and the ts of the topmost row in view. Grouped rows count, so a
 * tool group at the top still places the reader in its turn.
 *
 * The top message is read at most once per frame; scroll events fire far more
 * often than the rail can change.
 */
export function useTrajectoryRailViewport(scroller: HTMLElement | null): { scrolling: boolean; topVisibleTs?: number } {
    const [scrolling, setScrolling] = useState(false)
    const [topVisibleTs, setTopVisibleTs] = useState<number>()

    useEffect(() => {
        if (!scroller) return
        let frame: number | undefined
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const readTop = () => {
            frame = undefined
            setTopVisibleTs(findFirstVisibleRow(scroller, { minVisiblePx: RAIL_READING_MIN_VISIBLE_PX })?.ts)
        }
        const onScroll = () => {
            setScrolling(true)
            if (idleTimer) clearTimeout(idleTimer)
            idleTimer = setTimeout(() => setScrolling(false), RAIL_SCROLL_IDLE_MS)
            frame ??= requestAnimationFrame(readTop)
        }
        frame = requestAnimationFrame(readTop)
        scroller.addEventListener("scroll", onScroll, { passive: true })
        return () => {
            scroller.removeEventListener("scroll", onScroll)
            if (frame !== undefined) cancelAnimationFrame(frame)
            if (idleTimer) clearTimeout(idleTimer)
        }
    }, [scroller])

    return { scrolling, topVisibleTs }
}
