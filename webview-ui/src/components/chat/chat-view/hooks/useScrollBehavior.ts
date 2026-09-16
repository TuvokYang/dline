import { ClineMessage } from "@shared/ExtensionMessage"
import debounce from "debounce"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useEvent } from "react-use"
import { ListRange, VirtuosoHandle } from "react-virtuoso"
import { ScrollBehavior } from "../types/chatTypes"
import { findGroupedMessageByTs, resolveMessageRowExpanded, toggleMessageRowExpansion } from "../utils/messageUtils"
import { createScrollArbiter, LAYOUT_SETTLE_RETRY_MS, type ScrollRequest } from "../utils/scrollArbiter"

// Height of the sticky user message header (padding + content)
const STICKY_HEADER_HEIGHT = 32

/**
 * Custom hook for managing scroll behavior
 * Handles auto-scrolling, manual scrolling, and scroll-to-message functionality
 */
export function useScrollBehavior(
	messages: ClineMessage[],
	visibleMessages: ClineMessage[],
	groupedMessages: (ClineMessage | ClineMessage[])[],
	expandedRows: Record<number, boolean>,
	setExpandedRows: React.Dispatch<React.SetStateAction<Record<number, boolean>>>,
): ScrollBehavior & {
	showScrollToBottom: boolean
	setShowScrollToBottom: React.Dispatch<React.SetStateAction<boolean>>
	isAtBottom: boolean
	setIsAtBottom: React.Dispatch<React.SetStateAction<boolean>>
	pendingScrollToMessage: number | null
	setPendingScrollToMessage: React.Dispatch<React.SetStateAction<number | null>>
	scrolledPastUserMessage: ClineMessage | null
	handleRangeChanged: (range: ListRange) => void
} {
	// Refs
	const virtuosoRef = useRef<VirtuosoHandle>(null)
	const scrollContainerRef = useRef<HTMLDivElement>(null)
	const disableAutoScrollRef = useRef(false)
	// Ref mirror of isAtBottom so scroll handlers can read the latest value
	// without stale-closure issues (Virtuoso atBottomStateChange fires after scroll events)
	const isAtBottomRef = useRef(false)
	// Whether the loaded window reaches the end of the conversation. Paged
	// history means `isAtBottomRef` alone can describe the middle of it.
	const absoluteBottomLoadedRef = useRef(true)
	// Throttle timestamp for handleRowHeightChange to prevent scroll jitter
	const lastRowHeightChangeRef = useRef(0)
	const pendingAutoScrollRef = useRef(false)
	// Every programmatic scroll started here goes through one arbiter, so a new
	// intent always cancels the previous chain instead of fighting it.
	const scrollArbiterRef = useRef(createScrollArbiter())
	const requestProgrammaticScroll = useCallback((request: ScrollRequest) => {
		scrollArbiterRef.current.request(request)
	}, [])
	const cancelProgrammaticScroll = useCallback(() => {
		scrollArbiterRef.current.cancel()
	}, [])

	// State
	const [showScrollToBottom, setShowScrollToBottom] = useState(false)
	const [isAtBottom, setIsAtBottom] = useState(false)
	const [pendingScrollToMessage, setPendingScrollToMessage] = useState<number | null>(null)
	const [scrolledPastUserMessage, setScrolledPastUserMessage] = useState<ClineMessage | null>(null)

	// Find all user feedback messages
	const userFeedbackMessages = useMemo(() => {
		return visibleMessages.filter((msg) => msg.say === "user_feedback")
	}, [visibleMessages])

	// Track scroll position to detect which user message has been scrolled past
	// Shows the most recent user message that's above the current viewport
	const checkScrolledPastUserMessage = useCallback(() => {
		const scrollContainer = scrollContainerRef.current
		if (!scrollContainer || userFeedbackMessages.length === 0) {
			setScrolledPastUserMessage(null)
			return
		}

		const containerRect = scrollContainer.getBoundingClientRect()

		// Find the most recent (last in order) user message that's been scrolled past
		// We iterate from the end to find the latest one that's above the viewport
		let mostRecentScrolledPast: ClineMessage | null = null

		// Track if we've found any visible message element in the DOM
		// This helps us determine if missing elements are above or below viewport
		let foundAnyVisibleElement = false

		for (let i = userFeedbackMessages.length - 1; i >= 0; i--) {
			const msg = userFeedbackMessages[i]
			const messageElement = scrollContainer.querySelector(`[data-message-ts="${msg.ts}"]`) as HTMLElement

			if (messageElement) {
				foundAnyVisibleElement = true
				const messageRect = messageElement.getBoundingClientRect()
				// Message is scrolled past if its bottom edge is above (or near) the container's top
				// Add a small threshold so the pin appears slightly before message fully scrolls out
				const threshold = 10
				if (messageRect.bottom < containerRect.top + threshold) {
					mostRecentScrolledPast = msg
					break // Found the most recent one that's scrolled past
				}
			} else {
				// Element not in DOM - it's virtualized out
				// Only consider it scrolled past if we've already found a visible element after it
				// (meaning this missing element is above the viewport, not below)
				if (foundAnyVisibleElement) {
					mostRecentScrolledPast = msg
					break
				}
				// If we haven't found any visible elements yet, this message might be
				// below the viewport, so continue looking for visible elements
			}
		}

		setScrolledPastUserMessage(mostRecentScrolledPast)
	}, [userFeedbackMessages])

	// Use scroll event listener - attach to the scrollable element inside the container
	useEffect(() => {
		const scrollContainer = scrollContainerRef.current
		if (!scrollContainer) {
			return
		}

		// The scrollable element is the Virtuoso scroller or a child with overflow
		const findScrollableElement = () => {
			// Try finding the Virtuoso scroller
			const virtuosoScroller = scrollContainer.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement
			if (virtuosoScroller) {
				return virtuosoScroller
			}
			// Fallback to the first child with scrollable class
			const scrollable = scrollContainer.querySelector(".scrollable") as HTMLElement
			return scrollable || scrollContainer
		}

		const scrollableElement = findScrollableElement()

		const handleScroll = () => {
			checkScrolledPastUserMessage()
		}

		scrollableElement.addEventListener("scroll", handleScroll, { passive: true })

		// Also check on mount and when dependencies change
		checkScrolledPastUserMessage()

		return () => {
			scrollableElement.removeEventListener("scroll", handleScroll)
		}
	}, [checkScrolledPastUserMessage])

	// Handler for when visible range changes in Virtuoso (kept for compatibility but not used for sticky)
	const handleRangeChanged = useCallback((_range: ListRange) => {
		// Range changed callback - we now use scroll position instead
		// but keep this for potential future use
	}, [])
	// Refs for computing the last rendered Virtuoso row index.
	// The chat can group many messages into one row, so scroll targets must use
	// rendered row offsets instead of message indexes or totalMessageCount.
	const groupedLenRef = useRef(groupedMessages.length)
	groupedLenRef.current = groupedMessages.length

	const getLastRenderedRowIndex = useCallback(() => {
		const len = groupedLenRef.current
		return len - 1
	}, [])

	const performScrollToBottom = useCallback(
		(behavior: "auto" | "smooth") => {
			const lastIdx = getLastRenderedRowIndex()
			if (lastIdx >= 0) {
				virtuosoRef.current?.scrollToIndex({
					index: lastIdx,
					align: "end",
					behavior,
				})
			}
		},
		[getLastRenderedRowIndex],
	)

	// User-initiated smooth scroll (e.g., to-bottom button). Automatic
	// streaming scrolls use instant behavior to avoid competing animations.
	const scrollToBottomSmooth = useMemo(
		() =>
			debounce(() => {
				requestProgrammaticScroll({
					run: () => performScrollToBottom("smooth"),
					priority: "user",
				})
			}, 30),
		[performScrollToBottom, requestProgrammaticScroll],
	)

	// Programmatic instant scroll to bottom (auto-scroll, focus restore).
	const scrollToBottomAuto = useCallback(() => {
		requestProgrammaticScroll({
			run: () => performScrollToBottom("auto"),
			priority: "passive",
			isStillWanted: () => !disableAutoScrollRef.current && document.visibilityState !== "hidden",
		})
	}, [performScrollToBottom, requestProgrammaticScroll])

	const clearAutoScrollRetryTimers = cancelProgrammaticScroll

	/**
	 * Return to the bottom for a reader who was visually pinned there.
	 *
	 * This deliberately ignores `disableAutoScrollRef`. That flag records who
	 * owns the viewport, not where it sits: an upward nudge, a jump to a
	 * message or an expanded row all raise it, and only a downward wheel
	 * landing on the absolute bottom lowers it again. A reader who dragged the
	 * scrollbar down, or nudged up and came back, is therefore pinned to the
	 * bottom while the flag still reads "browsing", and every path that asks
	 * the flag first refuses to restore them.
	 *
	 * Ownership is released once, up front, rather than on every attempt.
	 * A restored panel settles late, so the scroll is retried for half a
	 * second, and re-clearing the flag each time would let a late attempt take
	 * the viewport back from a reader who had already grabbed it. Releasing it
	 * first instead lets the ordinary guard apply to the remaining attempts:
	 * anything that raises the flag again — a wheel, a jump, an expanded row —
	 * ends the chain, and a reader who does nothing keeps the settled bottom.
	 *
	 * The flag alone cannot end the chain, though. Every writer of it responds
	 * to an upward wheel or an explicit navigation, so dragging the scrollbar,
	 * pressing PageUp and touch scrolling leave it untouched. Those gestures do
	 * move the viewport, so the retries also stop once the reader is no longer
	 * at the end of the conversation, which Virtuoso reports independently.
	 */
	const restoreBottomAfterVisibility = useCallback(() => {
		disableAutoScrollRef.current = false
		requestProgrammaticScroll({
			run: () => performScrollToBottom("auto"),
			priority: "layout",
			retryDelaysMs: LAYOUT_SETTLE_RETRY_MS,
			isStillWanted: () =>
				!disableAutoScrollRef.current &&
				document.visibilityState !== "hidden" &&
				isAtBottomRef.current &&
				absoluteBottomLoadedRef.current,
		})
	}, [absoluteBottomLoadedRef, disableAutoScrollRef, isAtBottomRef, performScrollToBottom, requestProgrammaticScroll])

	const queueAutoScrollToBottom = useCallback(
		(retryAfterLayout = false) => {
			if (disableAutoScrollRef.current) {
				pendingAutoScrollRef.current = false
				cancelProgrammaticScroll()
				return
			}

			if (document.visibilityState === "hidden") {
				pendingAutoScrollRef.current = true
				return
			}

			pendingAutoScrollRef.current = false

			requestProgrammaticScroll({
				run: () => performScrollToBottom("auto"),
				priority: retryAfterLayout ? "layout" : "passive",
				retryDelaysMs: retryAfterLayout ? LAYOUT_SETTLE_RETRY_MS : undefined,
				// The user can grab the scrollbar between two attempts; re-checking
				// here is what stops a queued retry from yanking the view back.
				isStillWanted: () => !disableAutoScrollRef.current && document.visibilityState !== "hidden",
			})

			return cancelProgrammaticScroll
		},
		[cancelProgrammaticScroll, performScrollToBottom, requestProgrammaticScroll],
	)

	const scrollToMessage = useCallback(
		(messageIndex: number) => {
			setPendingScrollToMessage(messageIndex)

			const targetMessage = messages[messageIndex]
			if (!targetMessage) {
				setPendingScrollToMessage(null)
				return
			}

			const visibleIndex = visibleMessages.findIndex((msg) => msg.ts === targetMessage.ts)
			if (visibleIndex === -1) {
				setPendingScrollToMessage(null)
				return
			}

			let groupIndex = -1

			for (let i = 0; i < groupedMessages.length; i++) {
				const group = groupedMessages[i]
				if (Array.isArray(group)) {
					const messageInGroup = group.some((msg) => msg.ts === targetMessage.ts)
					if (messageInGroup) {
						groupIndex = i
						break
					}
				} else {
					if (group.ts === targetMessage.ts) {
						groupIndex = i
						break
					}
				}
			}

			if (groupIndex !== -1) {
				setPendingScrollToMessage(null)
				disableAutoScrollRef.current = true

				// Check if this is the first user feedback message (no sticky header would show when scrolling to it)
				const isFirstUserMessage =
					groupIndex === 0 || !visibleMessages.slice(0, visibleIndex).some((msg) => msg.say === "user_feedback")

				const stickyHeaderOffset = isFirstUserMessage ? 0 : STICKY_HEADER_HEIGHT

				// Use the shared arbiter so this user intent cancels any pending auto-scroll retry.
				requestProgrammaticScroll({
					run: () => {
						virtuosoRef.current?.scrollToIndex({
							index: groupIndex,
							align: "start",
							behavior: "smooth",
							offset: -stickyHeaderOffset,
						})
					},
					priority: "user",
				})
			}
		},
		[messages, visibleMessages, groupedMessages, requestProgrammaticScroll],
	)

	// scroll when user toggles certain rows
	const toggleRowExpansion = useCallback(
		(ts: number) => {
			const location = findGroupedMessageByTs(groupedMessages, ts)
			const message = location?.message
			const isCollapsing = resolveMessageRowExpanded(message, expandedRows)
			const lastGroup = groupedMessages.at(-1)
			const isLast = location?.groupIndex === groupedMessages.length - 1
			const isSecondToLast = location?.groupIndex === groupedMessages.length - 2

			const isLastCollapsedApiReq =
				isLast &&
				!Array.isArray(lastGroup) && // Make sure it's not a browser session group
				lastGroup?.say === "api_req_started" &&
				!expandedRows[lastGroup.ts]

			setExpandedRows((prev) => toggleMessageRowExpansion(message, prev))

			// disable auto scroll when user expands row
			if (!isCollapsing) {
				disableAutoScrollRef.current = true
			}
			// Only scroll on collapse, never on expand - expanding should stay in place
			if (isCollapsing && isAtBottom) {
				const timer = setTimeout(() => {
					scrollToBottomAuto()
				}, 0)
				return () => clearTimeout(timer)
			}
			if (isCollapsing && (isLast || isSecondToLast)) {
				if (isSecondToLast && !isLastCollapsedApiReq) {
					return
				}
				const timer = setTimeout(() => {
					scrollToBottomAuto()
				}, 0)
				return () => clearTimeout(timer)
			}
			// When expanding, don't scroll - let the element expand in place
		},
		[groupedMessages, expandedRows, scrollToBottomAuto, isAtBottom, setExpandedRows],
	)

	// Handle row height changes during streaming.
	// Throttled to max once per 120ms so rapid height changes (e.g. during
	// streaming or cancel) don't trigger cascading scrolls that cause jitter.
	// A row that shrank cannot push the bottom away, so following it would only
	// add a scroll command that competes with the one the growth already
	// scheduled.
	const handleRowHeightChange = useCallback(
		(isTaller: boolean) => {
			if (disableAutoScrollRef.current || !isTaller) {
				return
			}

			const now = Date.now()
			if (now - lastRowHeightChangeRef.current < 120) {
				return
			}
			lastRowHeightChangeRef.current = now

			queueAutoScrollToBottom()
		},
		[queueAutoScrollToBottom],
	)

	// Drop any pending scroll when the hook goes away; a retry firing against an
	// unmounted Virtuoso is what left the list stuck after a task switch.
	useEffect(() => cancelProgrammaticScroll, [cancelProgrammaticScroll])

	useEffect(() => {
		if (pendingScrollToMessage !== null) {
			scrollToMessage(pendingScrollToMessage)
		}
	}, [pendingScrollToMessage, scrollToMessage])

	useEffect(() => {
		if (!messages?.length) {
			setShowScrollToBottom(false)
		}
	}, [messages.length])

	const handleWheel = useCallback(
		(event: Event) => {
			const wheelEvent = event as WheelEvent
			if (wheelEvent.deltaY && wheelEvent.deltaY < 0) {
				if (scrollContainerRef.current?.contains(wheelEvent.target as Node)) {
					// User intent outranks every pending layout/follow retry.
					disableAutoScrollRef.current = true
					cancelProgrammaticScroll()
				}
			}
		},
		[cancelProgrammaticScroll],
	)
	useEvent("wheel", handleWheel, window, { passive: true }) // passive improves scrolling performance

	// When webview becomes visible again (user switches back to this tab),
	// scroll to bottom if auto-scroll is enabled. We wait one frame so Virtuoso
	// has a chance to re-layout after being hidden.
	// Both "focus" and "visibilitychange" are monitored to cover all cases
	// (window focus, tab switch, IDE panel toggle).
	useEffect(() => {
		const handleVisibility = () => {
			if (document.visibilityState === "hidden") {
				// Snapshot where the viewport physically was, not who owned it.
				// Reading ownership here is what stranded a reader who was sitting
				// at the bottom but had touched the scrollbar at some earlier point.
				//
				// Both halves are required. Virtuoso only knows the rows it holds,
				// and history is paged, so being at the bottom of the loaded window
				// can mean the middle of the conversation. Restoring "the bottom"
				// there would move the reader somewhere they never asked to be.
				pendingAutoScrollRef.current = isAtBottomRef.current && absoluteBottomLoadedRef.current
				return
			}

			if (pendingAutoScrollRef.current) {
				pendingAutoScrollRef.current = false
				restoreBottomAfterVisibility()
				return
			}

			if (!disableAutoScrollRef.current) {
				queueAutoScrollToBottom(true)
			}
		}
		window.addEventListener("focus", handleVisibility)
		window.addEventListener("resize", handleVisibility)
		document.addEventListener("visibilitychange", handleVisibility)
		return () => {
			window.removeEventListener("focus", handleVisibility)
			window.removeEventListener("resize", handleVisibility)
			document.removeEventListener("visibilitychange", handleVisibility)
			clearAutoScrollRetryTimers()
		}
	}, [clearAutoScrollRetryTimers, disableAutoScrollRef, isAtBottomRef, queueAutoScrollToBottom, restoreBottomAfterVisibility])

	return {
		virtuosoRef,
		scrollContainerRef,
		disableAutoScrollRef,
		isAtBottomRef,
		absoluteBottomLoadedRef,
		requestProgrammaticScroll,
		cancelProgrammaticScroll,
		scrollToBottomSmooth,
		scrollToBottomAuto,
		scrollToMessage,
		toggleRowExpansion,
		handleRowHeightChange,
		showScrollToBottom,
		setShowScrollToBottom,
		isAtBottom,
		setIsAtBottom,
		pendingScrollToMessage,
		setPendingScrollToMessage,
		scrolledPastUserMessage,
		handleRangeChanged,
	}
}
