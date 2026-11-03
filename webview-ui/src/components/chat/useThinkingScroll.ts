import { useCallback, useLayoutEffect, useRef, useState } from "react"

const EDGE_TOLERANCE = 2

/** Own only the reasoning viewport: following the stream never scrolls the surrounding conversation. */
export function useThinkingScroll(open: boolean, isStreaming: boolean) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const wasOpen = useRef(false)
    const following = useRef(true)
    const lastScrollTop = useRef(0)
    const [edges, setEdges] = useState({ canScrollUp: false, canScrollDown: false })
    const publishedEdges = useRef(edges)

    const updateEdges = useCallback(() => {
        const viewport = scrollRef.current
        if (!viewport) return
        const canScrollUp = viewport.scrollTop > EDGE_TOLERANCE
        const canScrollDown = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > EDGE_TOLERANCE
        if (publishedEdges.current.canScrollUp === canScrollUp && publishedEdges.current.canScrollDown === canScrollDown) return
        // Do not enqueue even an equal-state update on every layout commit.
        const next = { canScrollUp, canScrollDown }
        publishedEdges.current = next
        setEdges(next)
    }, [])

    const synchronize = useCallback(() => {
        const viewport = scrollRef.current
        if (!viewport) return
        if (isStreaming && following.current) {
            viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
        }
        // Record programmatic movement before the browser delivers its scroll event.
        lastScrollTop.current = viewport.scrollTop
        updateEdges()
    }, [isStreaming, updateEdges])

    const onScroll = useCallback(() => {
        const viewport = scrollRef.current
        if (!viewport) return
        const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= EDGE_TOLERANCE
        if (viewport.scrollTop < lastScrollTop.current) following.current = false
        else if (atBottom) following.current = true
        lastScrollTop.current = viewport.scrollTop
        updateEdges()
    }, [updateEdges])

    // Every committed content render may change scrollHeight, even after the viewport hits its height cap.
    useLayoutEffect(() => {
        if (!open) {
            wasOpen.current = false
            return
        }
        const viewport = scrollRef.current
        if (!viewport) return
        if (!wasOpen.current) {
            following.current = isStreaming
            viewport.scrollTop = 0
            wasOpen.current = true
        }
        synchronize()
    })

    useLayoutEffect(() => {
        const viewport = scrollRef.current
        const content = contentRef.current
        if (!open || !viewport || !content) return
        let active = true
        const observer = new ResizeObserver(() => {
            if (active) synchronize()
        })
        // Observe the natural-height content too: the capped viewport stops growing at 150px.
        observer.observe(viewport)
        observer.observe(content)
        return () => {
            active = false
            observer.disconnect()
        }
    }, [open, synchronize])

    return { scrollRef, contentRef, onScroll, ...edges }
}
