import { useCallback, useEffect, useLayoutEffect, useState } from "react"

/** Share of the chat height the rail may take before its bars scroll. */
export const RAIL_MAX_HEIGHT_RATIO = 0.8
/** Bar spacing while every turn fits with room to spare. */
const MAX_BAR_GAP_PX = 6
/** Tightest spacing that still reads as discrete bars; past it the rail scrolls instead. */
const MIN_BAR_GAP_PX = 2
/** Sub-pixel corrections are ignored so measuring cannot re-render in a loop. */
const GAP_TOLERANCE_PX = 0.5
/** Height of the fade at an edge that hides more bars. */
const EDGE_FADE_PX = 16

/** Whether bars are hidden past the top and the bottom edge of a scrolled rail. */
export interface ScrollEdges {
    readonly top: boolean
    readonly bottom: boolean
}

/**
 * Tightens the spacing between bars until every turn fits the rail's maximum height, down to the minimum spacing.
 *
 * The rail's height is linear in the gap, so one measurement of the spare room (or the overflow) gives the gap that
 * fills the available height exactly. `gapCount` is the number of gaps the spacing applies to.
 *
 * The layout hooks take the elements themselves, set through callback refs, so
 * a rail that mounts after the first render still gets measured and observed.
 */
export function useCompressedBarGap(rail: HTMLElement | null, scroller: HTMLElement | null, gapCount: number): number {
    const [gap, setGap] = useState(MAX_BAR_GAP_PX)
    const containerHeight = useContainerHeight(rail)

    // Runs after every render: a new turn or attempt changes the content height without changing `gapCount`.
    useLayoutEffect(() => {
        if (!rail || !scroller || containerHeight === 0) return
        if (gapCount === 0) {
            setGap(MAX_BAR_GAP_PX)
            return
        }
        const spare = containerHeight * RAIL_MAX_HEIGHT_RATIO - rail.offsetHeight
        const overflow = scroller.scrollHeight - scroller.clientHeight
        const target = Math.min(MAX_BAR_GAP_PX, Math.max(MIN_BAR_GAP_PX, gap + (spare - overflow) / gapCount))
        if (Math.abs(target - gap) > GAP_TOLERANCE_PX) setGap(target)
    })

    return gap
}

/**
 * Keeps the current turn's bar centered in a rail that scrolls, while the reader is not using the rail.
 *
 * Only the rail scrolls: `scrollIntoView` would also move the chat behind it.
 */
export function useFollowActiveTurn(scroller: HTMLElement | null, activeTurnTs: number | undefined, paused: boolean): void {
    useEffect(() => {
        if (!scroller || paused || activeTurnTs === undefined) return
        if (scroller.scrollHeight <= scroller.clientHeight) return
        const bar = scroller.querySelector<HTMLElement>(`[data-turn-ts="${activeTurnTs}"]`)
        if (!bar) return
        const barBox = bar.getBoundingClientRect()
        const viewBox = scroller.getBoundingClientRect()
        scroller.scrollBy({ top: barBox.top - viewBox.top - (viewBox.height - barBox.height) / 2, behavior: "smooth" })
    }, [scroller, activeTurnTs, paused])
}

/** Tracks which edges of the rail hide more bars, so each one can fade out. */
export function useScrollEdges(scroller: HTMLElement | null): ScrollEdges {
    const [edges, setEdges] = useState<ScrollEdges>({ top: false, bottom: false })

    const measure = useCallback(() => {
        if (!scroller) return
        const top = scroller.scrollTop > 1
        const bottom = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1
        setEdges((previous) => (previous.top === top && previous.bottom === bottom ? previous : { top, bottom }))
    }, [scroller])

    // Content and size changes move the edges as well as scrolling does.
    useLayoutEffect(measure)

    useEffect(() => {
        if (!scroller) return
        scroller.addEventListener("scroll", measure, { passive: true })
        return () => scroller.removeEventListener("scroll", measure)
    }, [scroller, measure])

    return edges
}

/** A mask that fades the rail out at each edge that hides more bars, or none when nothing is hidden. */
export function edgeFadeMask(edges: ScrollEdges): string | undefined {
    if (!edges.top && !edges.bottom) return undefined
    const start = edges.top ? `transparent, #000 ${EDGE_FADE_PX}px` : "#000"
    const end = edges.bottom ? `#000 calc(100% - ${EDGE_FADE_PX}px), transparent` : "#000"
    return `linear-gradient(to bottom, ${start}, ${end})`
}

/** Height of the positioned element the rail overlays, which bounds the rail's own height. */
function useContainerHeight(rail: HTMLElement | null): number {
    const [height, setHeight] = useState(0)

    useEffect(() => {
        const container = rail?.parentElement
        if (!container) return
        setHeight(container.clientHeight)
        if (typeof ResizeObserver === "undefined") return
        const observer = new ResizeObserver(() => setHeight(container.clientHeight))
        observer.observe(container)
        return () => observer.disconnect()
    }, [rail])

    return height
}
