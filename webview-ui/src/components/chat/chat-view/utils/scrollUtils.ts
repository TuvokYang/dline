/**
 * Utility functions for scroll behavior and management
 */

import debounce from "debounce"
import { VirtuosoHandle } from "react-virtuoso"

const SCROLL_EDGE_EPSILON_PX = 1

/**
 * Create a debounced smooth scroll function
 */
export function createSmoothScrollToBottom(virtuosoRef: React.RefObject<VirtuosoHandle>) {
    return debounce(
        () => {
            virtuosoRef.current?.scrollTo({
                top: Number.MAX_SAFE_INTEGER,
                behavior: "smooth",
            })
        },
        10,
        { immediate: true },
    )
}

/**
 * Scroll to bottom with auto behavior
 */
export function scrollToBottomAuto(virtuosoRef: React.RefObject<VirtuosoHandle>) {
    virtuosoRef.current?.scrollTo({
        top: Number.MAX_SAFE_INTEGER,
        behavior: "auto", // instant causes crash
    })
}

/**
 * Handle wheel events to detect user scroll
 */
export function createWheelHandler(
    scrollContainerRef: React.RefObject<HTMLDivElement>,
    disableAutoScrollRef: React.MutableRefObject<boolean>,
) {
    return (event: Event) => {
        const wheelEvent = event as WheelEvent
        if (wheelEvent.deltaY && wheelEvent.deltaY < 0) {
            if (scrollContainerRef.current?.contains(wheelEvent.target as Node)) {
                // user scrolled up
                disableAutoScrollRef.current = true
            }
        }
    }
}

function elementFromTarget(target: EventTarget | null): HTMLElement | null {
    if (target instanceof HTMLElement) return target
    if (target instanceof Node) return target.parentElement
    return null
}

function hasScrollableOverflow(element: HTMLElement): boolean {
    const overflowY = getComputedStyle(element).overflowY
    return (
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        element.scrollHeight > element.clientHeight + SCROLL_EDGE_EPSILON_PX
    )
}

function canConsumeVerticalDelta(element: HTMLElement, deltaY: number): boolean {
    if (!hasScrollableOverflow(element)) return false
    if (deltaY < 0) return element.scrollTop > SCROLL_EDGE_EPSILON_PX
    if (deltaY > 0) {
        return element.scrollTop + element.clientHeight < element.scrollHeight - SCROLL_EDGE_EPSILON_PX
    }
    return false
}

/**
 * Whether a nested vertical scroller owns this wheel delta before the chat list.
 *
 * The boundary itself is excluded: reaching a card's edge deliberately hands the
 * gesture back to the Virtuoso scroller, while a card that can still move keeps
 * session follow/browsing ownership unchanged.
 */
export function nestedScrollerConsumesWheel(target: EventTarget | null, boundary: HTMLElement | null, deltaY: number): boolean {
    if (!boundary || deltaY === 0) return false
    let element = elementFromTarget(target)
    if (!element || !boundary.contains(element)) return false

    while (element && element !== boundary) {
        if (canConsumeVerticalDelta(element, deltaY)) return true
        element = element.parentElement
    }
    return false
}

/**
 * Constants for scroll behavior
 */
export const SCROLL_CONSTANTS = {
    AT_BOTTOM_THRESHOLD: 10,
    VIEWPORT_INCREASE_TOP: 3_000,
    VIEWPORT_INCREASE_BOTTOM: Number.MAX_SAFE_INTEGER,
    FOOTER_HEIGHT: 5,
} as const
