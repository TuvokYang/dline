import type { ClineMessage } from "@shared/ExtensionMessage"
import { FetchMessageRequest } from "@shared/proto/dline/task"
import { convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import type React from "react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Virtuoso } from "react-virtuoso"
import { StickyUserMessage } from "@/components/chat/task-header/StickyUserMessage"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { isApiReqActive } from "@/utils/streaming"

import { useBrowsingScrollAnchor } from "../../hooks/useBrowsingScrollAnchor"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { isToolGroup } from "../../utils/messageUtils"
import {
	DEFAULT_MESSAGE_WINDOW_LIMITS,
	isWholeConversationLoaded,
	leadingBuffer,
	type MessageWindow,
	planWindowExtensions,
	trailingBuffer,
	type VisibleMessageRange,
} from "../../utils/messageWindowPlan"
import { buildMessageRowKey, getBottomFollowIntent, mergeMessageWindow } from "../../utils/messageWindowUtils"
import { advanceRowCoordinate, ROW_INDEX_BASE, type RowCoordinate } from "../../utils/rowCoordinate"
import { LAYOUT_SETTLE_RETRY_MS } from "../../utils/scrollArbiter"
import { decideWindowGrowth, SCROLL_SETTLE_MS } from "../../utils/windowGrowthTiming"
import { createMessageRenderer } from "../messages/MessageRenderer"

const LOAD_COUNT = DEFAULT_MESSAGE_WINDOW_LIMITS.loadCount
/**
 * Rendered rows left beyond the viewport before a fetch is requested.
 *
 * Grouping collapses many messages into one row, so a window that still holds
 * plenty of messages can be only a few rows away from its edge.
 */
const ROW_LOAD_THRESHOLD = 8
const USER_SCROLL_INTENT_TTL_MS = 750

/** Sentinel value to prevent Virtuoso zero-sized-element warnings when data is empty */
// @ts-expect-error — Virtuoso sentinel; only ts/type needed, full ClineMessage shape not required
const EMPTY_PLACEHOLDER_MSG: ClineMessage = { ts: -1, type: "__empty_placeholder__" } as ClineMessage

interface MessagesAreaProps {
	task: ClineMessage
	groupedMessages: (ClineMessage | ClineMessage[])[]
	modifiedMessages: ClineMessage[]
	scrollBehavior: ScrollBehavior
	chatState: ChatState
	messageHandlers: MessageHandlers
	onFollowupOptionSelect: (message: ClineMessage, option: string) => Promise<void>
}

type RenderRow = {
	row: ClineMessage | ClineMessage[]
	startMessageIndex: number
	endMessageIndex: number
	startMessageTs?: number
	endMessageTs?: number
}

type PendingAnchor = {
	ts: number
	align: "start" | "center" | "end"
}

type ScrollEdge = "top" | "bottom"
type UserScrollIntent = { direction: "up" | "down"; recordedAt: number }
type TailMessageSnapshot = {
	ts: number
	contentSignature: string
	renderSignature: string
}

function createTailMessageSnapshot(message: ClineMessage | undefined): TailMessageSnapshot | null {
	if (!message) return null
	const contentSignature = JSON.stringify([message.partial === true, message.text ?? ""])
	return {
		ts: message.ts,
		contentSignature,
		renderSignature: JSON.stringify([
			message.type,
			message.ask ?? message.say ?? "",
			message.interactionId ?? "",
			contentSignature,
		]),
	}
}

export const MessagesArea: React.FC<MessagesAreaProps> = ({
	task,
	groupedMessages,
	modifiedMessages,
	scrollBehavior,
	chatState,
	messageHandlers,
	onFollowupOptionSelect,
}) => {
	const { clineMessages, setClineMessages, totalMessageCount, firstItemIndex, setFirstItemIndex } = useExtensionState()

	const firstItemIndexRef = useRef(firstItemIndex)
	const clineMessagesLengthRef = useRef(clineMessages.length)
	const inflightRef = useRef<Set<string>>(new Set())
	const pendingAnchorRef = useRef<PendingAnchor | null>(null)
	const pendingEdgeScrollRef = useRef<ScrollEdge | null>(null)
	const latestVisibleMessageRangeRef = useRef<VisibleMessageRange | null>(null)
	const latestExtensionRangeRef = useRef<VisibleMessageRange | null>(null)
	const latestVisibleAnchorTsRef = useRef<number | null>(null)
	const userScrollIntentRef = useRef<UserScrollIntent | null>(null)
	/** When the reader last moved the viewport, used to defer window growth. */
	const lastScrollAtRef = useRef<number | null>(null)
	const deferredGrowthRef = useRef<{ visible: VisibleMessageRange; anchorTs: number | null } | null>(null)
	const deferredGrowthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	/**
	 * Indirection so the visibility listener can replay a deferred fetch.
	 *
	 * That listener is installed once, before the callback it needs exists, and
	 * must not be re-subscribed on every render.
	 */
	const replayDeferredWindowGrowthRef = useRef<(() => void) | null>(null)
	const [scroller, setScroller] = useState<HTMLElement | null>(null)
	const scrollerRef = useCallback((element: HTMLElement | Window | null) => {
		setScroller(element instanceof HTMLElement ? element : null)
	}, [])
	const { capture: captureBrowsingViewportAnchor, scheduleRestore: scheduleBrowsingViewportAnchorRestore } =
		useBrowsingScrollAnchor(clineMessages, task.ts, scroller, scrollBehavior)
	const windowVersionRef = useRef(0)
	const edgeJumpInFlightRef = useRef<ScrollEdge | null>(null)

	// Floating scroll-to-bottom/top button state
	const [floatingBtnVisible, setFloatingBtnVisible] = useState(false)
	const [floatingBtnDir, setFloatingBtnDir] = useState<"bottom" | "top">("bottom")
	const hideBtnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const wasBtnShownRef = useRef(false)
	const showScrollToBottomRef = useRef(false)
	// Track webview visibility so we can pause Virtuoso updates when hidden
	const [isWebviewHidden, setIsWebviewHidden] = useState(() => document.visibilityState === "hidden")
	const isWebviewHiddenRef = useRef(isWebviewHidden)
	isWebviewHiddenRef.current = isWebviewHidden
	const tailMessageSnapshotRef = useRef<TailMessageSnapshot | null>(null)
	// A hidden snapshot belongs to exactly one Task and is invalidated on visibility restoration.
	const cachedVisibleMessagesRef = useRef<{ taskTs: number; rows: (ClineMessage | ClineMessage[])[] } | null>(null)

	// Layout effects run before passive effects. Keep these mirrors current during
	// render so initial async hydration can calculate the real loaded bottom.
	firstItemIndexRef.current = firstItemIndex
	clineMessagesLengthRef.current = clineMessages.length

	const lastRawMessage = useMemo(() => clineMessages.at(-1), [clineMessages])
	const tailMessageSnapshot = useMemo(() => createTailMessageSnapshot(lastRawMessage), [lastRawMessage])

	// Reset auto-scroll flag when entering a new task so the view scrolls
	// to the bottom instead of staying wherever the previous task left it.
	useLayoutEffect(() => {
		void task.ts
		scrollBehavior.disableAutoScrollRef.current = false
		windowVersionRef.current += 1
		inflightRef.current.clear()
		pendingAnchorRef.current = null
		pendingEdgeScrollRef.current = null
		latestVisibleMessageRangeRef.current = null
		latestExtensionRangeRef.current = null
		latestVisibleAnchorTsRef.current = null
		userScrollIntentRef.current = null
		tailMessageSnapshotRef.current = null
		scrollBehavior.cancelProgrammaticScroll()
	}, [task.ts, scrollBehavior.cancelProgrammaticScroll, scrollBehavior.disableAutoScrollRef])

	const {
		virtuosoRef,
		scrollContainerRef,
		toggleRowExpansion,
		handleRowHeightChange,
		setIsAtBottom,
		setShowScrollToBottom,
		disableAutoScrollRef,
		requestProgrammaticScroll,
		cancelProgrammaticScroll,
		scrolledPastUserMessage,
		isAtBottomRef,
		absoluteBottomLoadedRef,
		showScrollToBottom,
	} = scrollBehavior

	useEffect(() => {
		showScrollToBottomRef.current = showScrollToBottom
	}, [showScrollToBottom])

	// Pause range processing while the webview is hidden. Restoring the bottom
	// is owned by useScrollBehavior so only one visibility listener can issue a
	// programmatic scroll through the shared arbiter.
	useEffect(() => {
		const handleVisibility = () => {
			const hidden = document.visibilityState === "hidden"
			isWebviewHiddenRef.current = hidden
			setIsWebviewHidden(hidden)
			// Becoming visible again is the one moment a deferred fetch can be
			// stranded: range processing was suspended while hidden, and Virtuoso
			// is not obliged to publish a new range once the view returns. The
			// scroll that deferred the fetch may also never resume, because the
			// reader left and came back rather than kept scrolling.
			if (!hidden) replayDeferredWindowGrowthRef.current?.()
		}

		handleVisibility()
		document.addEventListener("visibilitychange", handleVisibility)
		return () => document.removeEventListener("visibilitychange", handleVisibility)
	}, [])

	const messageIndexByTs = useMemo(() => {
		const map = new Map<number, number>()

		clineMessages.forEach((msg, offset) => {
			map.set(msg.ts, firstItemIndex + offset)
		})

		return map
	}, [clineMessages, firstItemIndex])

	const renderRows = useMemo<RenderRow[]>(() => {
		let fallbackIndex = firstItemIndex

		return groupedMessages.map((row) => {
			const rowMessages = Array.isArray(row) ? row : [row]

			const mappedIndexes = rowMessages
				.map((msg) => messageIndexByTs.get(msg.ts))
				.filter((index): index is number => typeof index === "number")

			const startMessageIndex = mappedIndexes.length > 0 ? Math.min(...mappedIndexes) : fallbackIndex
			const endMessageIndex =
				mappedIndexes.length > 0 ? Math.max(...mappedIndexes) : startMessageIndex + rowMessages.length - 1

			fallbackIndex = Math.max(fallbackIndex, endMessageIndex + 1)

			return {
				row,
				startMessageIndex,
				endMessageIndex,
				startMessageTs: rowMessages.at(0)?.ts,
				endMessageTs: rowMessages.at(-1)?.ts,
			}
		})
	}, [groupedMessages, messageIndexByTs, firstItemIndex])

	// Virtuoso remembers the height it measured for a row by the row's index, and
	// relies on `firstItemIndex` moving to tell it that those indices now refer to
	// different rows. This list is windowed — older messages load in ahead of the
	// ones already on screen — so a row that was measured at index 106 can find
	// itself at index 297. Reporting a fixed 0 leaves the library no way to carry
	// the measurement across, so it falls back to its default estimate and
	// corrects the scroll position once the real height arrives, which is the
	// jump the reader sees.
	//
	// The coordinate below is expressed in *rows*, not messages: filtering and
	// grouping mean several messages can collapse into one row, so the message
	// window offset cannot be reused here. It is derived by finding where the
	// previously known rows ended up in the new list and shifting the origin by
	// the same amount. A base offset keeps the value positive when history is
	// prepended.
	const rowCoordinateRef = useRef<RowCoordinate>({ firstItemIndex: ROW_INDEX_BASE, identities: [] })
	const rowCoordinate = useMemo(
		() =>
			advanceRowCoordinate(
				rowCoordinateRef.current,
				renderRows.map((renderRow) => renderRow.row),
			),
		[renderRows],
	)
	// Committing in a layout effect keeps the ref from being written during
	// render, which would make the result depend on how many times React chooses
	// to render.
	useLayoutEffect(() => {
		rowCoordinateRef.current = rowCoordinate
	}, [rowCoordinate])

	const visibleGroupedMessages = useMemo<(ClineMessage | ClineMessage[])[]>(() => {
		// When the webview is hidden (user switched to another tab), return the
		// cached snapshot so Virtuoso stays idle instead of re-laying-out invisibly.
		if (isWebviewHidden) {
			const cached = cachedVisibleMessagesRef.current
			if (cached?.taskTs === task.ts) {
				return cached.rows
			}
		}

		const rows = renderRows.map((renderRow) => renderRow.row)
		// Prevent Virtuoso zero-sized-element warning when data is empty.
		// A single invisible placeholder row keeps Virtuoso's measurement happy.
		let result: (ClineMessage | ClineMessage[])[]
		if (rows.length === 0) {
			result = [EMPTY_PLACEHOLDER_MSG]
		} else {
			result = rows
		}
		// Always update the cache when we compute a fresh result so the next
		// hidden-cycle can reuse it.
		cachedVisibleMessagesRef.current = { taskTs: task.ts, rows: result }
		return result
	}, [isWebviewHidden, renderRows, task.ts])

	const findRowOffsetByMessageTs = useCallback(
		(ts: number) => {
			return renderRows.findIndex((renderRow) => {
				if (Array.isArray(renderRow.row)) {
					return renderRow.row.some((msg) => msg.ts === ts)
				}

				return renderRow.row.ts === ts
			})
		},
		[renderRows],
	)

	const scrollToRowOffset = useCallback(
		(index: number, align: "start" | "center" | "end" = "start", behavior: "auto" | "smooth" = "smooth") => {
			// Announce that the next scroll write belongs to the application.
			//
			// The pending-anchor restore and sticky navigation reach the list
			// directly rather than through the scroll arbiter, so without this
			// the diagnostics see a write with no application mark and attribute
			// it to the list's own compensation. Reading the mark is test-only;
			// nothing here changes when it is absent.
			;(window as { __dlineMarkAppScroll?: () => void }).__dlineMarkAppScroll?.()
			virtuosoRef.current?.scrollToIndex({
				index,
				align,
				behavior,
			})
		},
		[virtuosoRef],
	)

	const clearEdgeScrollTimers = cancelProgrammaticScroll

	/**
	 * Read the absolute bounds of the currently loaded message window.
	 *
	 * @returns Window bounds derived from the live refs and the backend total.
	 */
	const currentMessageWindow = useCallback((): MessageWindow => {
		const start = firstItemIndexRef.current
		const length = clineMessagesLengthRef.current
		return { start, length, total: totalMessageCount ?? length }
	}, [totalMessageCount])

	/**
	 * Report whether the loaded window already covers the requested edge.
	 *
	 * @param edge Conversation edge the pending jump targets.
	 * @returns True when scrolling now lands on the real first or last message.
	 */
	const isEdgeWindowReady = useCallback(
		(edge: ScrollEdge) => {
			if (renderRows.length === 0) return false

			const window = currentMessageWindow()
			return edge === "top" ? window.start <= 0 : window.start + window.length >= window.total
		},
		[currentMessageWindow, renderRows.length],
	)

	const scrollToBottomLast = useCallback(
		(behavior: "auto" | "smooth" = "auto") => {
			virtuosoRef.current?.scrollToIndex({
				index: "LAST",
				align: "end",
				behavior,
			})
		},
		[virtuosoRef],
	)

	const scrollToLoadedEdge = useCallback(
		(edge: ScrollEdge, behavior: "auto" | "smooth" = "auto", retryAfterLayout = false) => {
			if (renderRows.length === 0) return

			const index = edge === "top" ? 0 : renderRows.length - 1
			const align = edge === "top" ? "start" : "end"

			requestProgrammaticScroll({
				run: () => {
					if (edge === "bottom") {
						scrollToBottomLast(behavior)
						return
					}
					scrollToRowOffset(index, align, behavior)
				},
				priority: retryAfterLayout ? "layout" : "passive",
				// Streaming issues this on nearly every chunk. Retrying each of them
				// stacked hundreds of deferred scrolls and produced the bounce, so
				// only an explicit jump asks for the settle chain.
				retryDelaysMs: retryAfterLayout ? LAYOUT_SETTLE_RETRY_MS : undefined,
				isStillWanted: () => edge === "top" || !disableAutoScrollRef.current,
			})
		},
		[disableAutoScrollRef, renderRows.length, requestProgrammaticScroll, scrollToBottomLast, scrollToRowOffset],
	)

	const handleMeasuredLayoutChange = useCallback(() => {
		if (disableAutoScrollRef.current) {
			scheduleBrowsingViewportAnchorRestore()
			return
		}
		if (!isWebviewHiddenRef.current && isEdgeWindowReady("bottom")) {
			scrollToLoadedEdge("bottom")
		}
	}, [disableAutoScrollRef, isEdgeWindowReady, scheduleBrowsingViewportAnchorRestore, scrollToLoadedEdge])

	useEffect(() => {
		if (!scroller) return
		// Input/header changes resize this element without resizing window.
		const observer = new ResizeObserver(handleMeasuredLayoutChange)
		observer.observe(scroller)
		return () => observer.disconnect()
	}, [handleMeasuredLayoutChange, scroller])

	useLayoutEffect(() => {
		const pendingEdge = pendingEdgeScrollRef.current
		if (pendingEdge) {
			// The jump replaced the whole window, but React can run this effect
			// against the previous rows. Landing on a stale window is what made
			// "to top" and "to bottom" stop short of the real edge, so wait until
			// the window that the jump requested is the one being rendered.
			if (!isEdgeWindowReady(pendingEdge)) {
				return
			}
			pendingEdgeScrollRef.current = null
			// Row heights are unknown until Virtuoso measures the new window.
			scrollToLoadedEdge(pendingEdge, "auto", true)
			return
		}

		const pendingAnchor = pendingAnchorRef.current
		if (!pendingAnchor) return
		if (renderRows.length === 0) return

		const rowOffset = findRowOffsetByMessageTs(pendingAnchor.ts)
		if (rowOffset < 0) return

		pendingAnchorRef.current = null
		scrollToRowOffset(rowOffset, pendingAnchor.align, "auto")
	}, [renderRows.length, findRowOffsetByMessageTs, isEdgeWindowReady, scrollToLoadedEdge, scrollToRowOffset])

	useEffect(() => clearEdgeScrollTimers, [clearEdgeScrollTimers])

	useLayoutEffect(() => {
		const window = currentMessageWindow()
		const absoluteBottomLoaded = window.start + window.length >= window.total
		const previousSnapshot = tailMessageSnapshotRef.current
		const lastMessageTsChanged = previousSnapshot?.ts !== tailMessageSnapshot?.ts
		const lastMessageContentChanged =
			previousSnapshot !== null && previousSnapshot.renderSignature !== tailMessageSnapshot?.renderSignature
		const renderIdentityChangedWithoutContent =
			previousSnapshot !== null &&
			tailMessageSnapshot !== null &&
			previousSnapshot.ts === tailMessageSnapshot.ts &&
			previousSnapshot.contentSignature === tailMessageSnapshot.contentSignature &&
			previousSnapshot.renderSignature !== tailMessageSnapshot.renderSignature
		tailMessageSnapshotRef.current = tailMessageSnapshot

		const intent = getBottomFollowIntent({
			disableAutoScroll: disableAutoScrollRef.current,
			absoluteBottomLoaded,
			lastMessageTsChanged,
			lastMessageContentChanged,
		})

		if (intent === "follow" && previousSnapshot !== null) {
			scrollToLoadedEdge("bottom", "auto", renderIdentityChangedWithoutContent)
		}
	}, [currentMessageWindow, disableAutoScrollRef, scrollToLoadedEdge, tailMessageSnapshot])

	const scrolledPastUserMessageRowOffset = useMemo(() => {
		if (!scrolledPastUserMessage) return -1
		return findRowOffsetByMessageTs(scrolledPastUserMessage.ts)
	}, [findRowOffsetByMessageTs, scrolledPastUserMessage])

	const handleScrollToUserMessage = useCallback(() => {
		if (scrolledPastUserMessageRowOffset >= 0) {
			scrollToRowOffset(scrolledPastUserMessageRowOffset, "center")
		}
	}, [scrolledPastUserMessageRowOffset, scrollToRowOffset])

	const { expandedRows, setActiveQuote, setInputValue } = chatState
	const addToInput = useCallback(
		(text: string) => setInputValue((current) => (current ? `${current}\n${text}\n` : `${text}\n`)),
		[setInputValue],
	)

	const lastVisibleRow = useMemo(() => visibleGroupedMessages.at(-1), [visibleGroupedMessages])

	const lastVisibleMessage = useMemo(() => {
		const lastRow = lastVisibleRow
		if (!lastRow) return undefined
		return Array.isArray(lastRow) ? lastRow.at(-1) : lastRow
	}, [lastVisibleRow])

	const isWaitingForResponse = useMemo(() => {
		const lastMsg = modifiedMessages[modifiedMessages.length - 1]

		if (lastRawMessage?.type === "ask") return false
		if (lastRawMessage?.type === "say" && lastRawMessage.say === "completion_result") return false

		if (lastRawMessage?.type === "say" && lastRawMessage.say === "api_req_started" && !isApiReqActive(lastRawMessage)) {
			return false
		}

		if (visibleGroupedMessages.length === 0) return true
		if (!lastVisibleMessage) return true
		if (lastVisibleRow && isToolGroup(lastVisibleRow)) return true
		if (lastVisibleMessage.partial !== true) return true
		if (!lastMsg) return true
		if (lastMsg.say === "user_feedback" || lastMsg.say === "user_feedback_diff") return true

		if (lastMsg.say === "api_req_started") {
			try {
				const info = JSON.parse(lastMsg.text || "{}")
				return info.cost == null
			} catch {
				return true
			}
		}

		return false
	}, [lastRawMessage, visibleGroupedMessages.length, lastVisibleMessage, lastVisibleRow, modifiedMessages])

	const showThinkingLoaderRow = useMemo(() => {
		const handoffToReasoningPending =
			lastRawMessage?.type === "say" &&
			lastRawMessage.say === "reasoning" &&
			lastRawMessage.partial === true &&
			lastVisibleMessage?.say !== "reasoning"

		return isWaitingForResponse || handoffToReasoningPending
	}, [isWaitingForResponse, lastRawMessage, lastVisibleMessage?.say])

	const itemContent = useMemo(() => {
		const realRenderer = createMessageRenderer(
			visibleGroupedMessages,
			modifiedMessages,
			expandedRows,
			toggleRowExpansion,
			handleRowHeightChange,
			addToInput,
			setActiveQuote,
			onFollowupOptionSelect,
			messageHandlers,
			false,
		)

		// Wrap to handle the empty placeholder row — returns a 1px invisible
		// spacer so Virtuoso never encounters a zero-sized element.
		return (index: number, item: ClineMessage | ClineMessage[]) => {
			if (item === EMPTY_PLACEHOLDER_MSG) {
				return <div style={{ height: 1 }} />
			}
			// The renderer compares the index against the loaded window to decide
			// which row is last, so it needs the window-relative position rather
			// than the coordinate Virtuoso reports. Clamping keeps a negative
			// offset — possible for one frame while the coordinate catches up with
			// the data — from making every row look like it is not the last.
			const localIndex = Math.min(Math.max(index - rowCoordinate.firstItemIndex, 0), visibleGroupedMessages.length - 1)
			return realRenderer(localIndex, item)
		}
	}, [
		rowCoordinate.firstItemIndex,
		visibleGroupedMessages,
		modifiedMessages,
		expandedRows,
		toggleRowExpansion,
		handleRowHeightChange,
		addToInput,
		setActiveQuote,
		onFollowupOptionSelect,
		messageHandlers,
	])

	const virtuosoComponents = useMemo(
		() => ({
			Footer: () => (
				<>
					{showThinkingLoaderRow && <div className="min-h-1" />}
					<div className="min-h-1" />
				</>
			),
		}),
		[showThinkingLoaderRow],
	)

	const computeItemKey = useCallback((index: number, item: ClineMessage | ClineMessage[]) => {
		return buildMessageRowKey(item, index)
	}, [])

	const fetchAndMerge = useCallback(
		async (start: number, count: number, anchor?: PendingAnchor) => {
			const key = `${start}:${count}`
			if (inflightRef.current.has(key)) return false

			inflightRef.current.add(key)
			const requestVersion = windowVersionRef.current

			if (anchor) {
				pendingAnchorRef.current = anchor
			}

			try {
				const resp = await TaskServiceClient.fetchMessage(FetchMessageRequest.create({ referenceIndex: start, count }))
				const msgs = resp.messages.map((message) => convertProtoToClineMessage(message))
				const si = resp.startIndex

				if (requestVersion !== windowVersionRef.current) {
					if (anchor) pendingAnchorRef.current = null
					return false
				}

				if (msgs.length === 0) {
					if (anchor) pendingAnchorRef.current = null
					return false
				}

				let merged = false

				setClineMessages((prev) => {
					const fi = firstItemIndexRef.current
					const result = mergeMessageWindow({
						existing: prev,
						incoming: msgs,
						existingStartIndex: fi,
						incomingStartIndex: si,
					})

					if (!result.merged) {
						return prev
					}

					merged = true
					clineMessagesLengthRef.current = result.messages.length

					if (result.firstItemIndex !== fi) {
						firstItemIndexRef.current = result.firstItemIndex
						setFirstItemIndex(result.firstItemIndex)
					}

					return result.messages
				})

				if (!merged && anchor) {
					pendingAnchorRef.current = null
				}

				return merged
			} catch (e) {
				if (anchor) pendingAnchorRef.current = null
				console.error("fetchMessage:", e)
				return false
			} finally {
				inflightRef.current.delete(key)
			}
		},
		[setClineMessages, setFirstItemIndex],
	)

	const requestWindowExtensions = useCallback(
		(visible: VisibleMessageRange, anchorTs: number | null) => {
			if (isWebviewHiddenRef.current) return

			const window = currentMessageWindow()
			if (isWholeConversationLoaded(window)) return

			const planned = planWindowExtensions(window, visible)
			if (planned.length === 0) return

			// Growing the window at the leading edge inserts rows above the
			// viewport and releases them from the far side, which moves the
			// content the reader is looking at. Mid-scroll that is visible as the
			// transcript sliding, so it waits for the gesture to end.
			//
			// Only the leading side is deferrable. The trailing side is how newly
			// arriving messages become reachable, and holding that back would
			// leave a live reply stranded outside the loaded window.
			const deferrable = planned.filter((extension) => extension.side === "leading")
			const immediate = planned.filter((extension) => extension.side !== "leading")

			const decision =
				deferrable.length === 0
					? "run"
					: decideWindowGrowth({
							msSinceLastScroll: lastScrollAtRef.current === null ? null : Date.now() - lastScrollAtRef.current,
							messagesToLeadingEdge: leadingBuffer(window, visible),
							messagesToTrailingEdge: trailingBuffer(window, visible),
						})

			const extensions = decision === "defer" ? immediate : planned
			if (decision === "defer") {
				// Remembered rather than dropped: the reader may stop scrolling
				// without Virtuoso publishing another range, and the fetch would
				// never be asked for again.
				deferredGrowthRef.current = { visible, anchorTs }
			} else {
				deferredGrowthRef.current = null
			}

			for (const extension of extensions) {
				if (extension.side === "leading") {
					if (anchorTs == null) continue
					void fetchAndMerge(extension.startIndex, extension.count, {
						ts: anchorTs,
						align: "start",
					})
					continue
				}
				void fetchAndMerge(extension.startIndex, extension.count)
			}
		},
		[currentMessageWindow, fetchAndMerge],
	)

	/**
	 * Replay a deferred extension once the scroll has settled.
	 *
	 * Called on every scroll event, so the timer restarts instead of stacking:
	 * only the last event of a gesture gets to fire.
	 */
	const scheduleDeferredWindowGrowth = useCallback(() => {
		if (deferredGrowthTimerRef.current !== null) clearTimeout(deferredGrowthTimerRef.current)
		deferredGrowthTimerRef.current = setTimeout(() => {
			deferredGrowthTimerRef.current = null
			const deferred = deferredGrowthRef.current
			if (!deferred) return
			deferredGrowthRef.current = null
			requestWindowExtensions(deferred.visible, deferred.anchorTs)
		}, SCROLL_SETTLE_MS)
	}, [requestWindowExtensions])

	/** Run a deferred extension straight away, without waiting for the timer. */
	const replayDeferredWindowGrowth = useCallback(() => {
		if (deferredGrowthTimerRef.current !== null) {
			clearTimeout(deferredGrowthTimerRef.current)
			deferredGrowthTimerRef.current = null
		}
		const deferred = deferredGrowthRef.current
		if (!deferred) return
		deferredGrowthRef.current = null
		requestWindowExtensions(deferred.visible, deferred.anchorTs)
	}, [requestWindowExtensions])

	useLayoutEffect(() => {
		replayDeferredWindowGrowthRef.current = replayDeferredWindowGrowth
	}, [replayDeferredWindowGrowth])

	useEffect(() => {
		return () => {
			if (deferredGrowthTimerRef.current !== null) clearTimeout(deferredGrowthTimerRef.current)
		}
	}, [])

	const jumpToEdge = useCallback(
		async (edge: ScrollEdge) => {
			if (edgeJumpInFlightRef.current === edge) return

			edgeJumpInFlightRef.current = edge
			windowVersionRef.current += 1
			const requestVersion = windowVersionRef.current
			inflightRef.current.clear()
			pendingAnchorRef.current = null
			latestVisibleMessageRangeRef.current = null
			latestExtensionRangeRef.current = null
			latestVisibleAnchorTsRef.current = null
			pendingEdgeScrollRef.current = edge

			try {
				const request =
					edge === "top"
						? FetchMessageRequest.create({ referenceIndex: 0, count: LOAD_COUNT })
						: FetchMessageRequest.create({ referenceIndex: -1, count: LOAD_COUNT })

				const resp = await TaskServiceClient.fetchMessage(request)
				if (requestVersion !== windowVersionRef.current) return

				const converted = resp.messages.map((message) => convertProtoToClineMessage(message))
				const nextFirstItemIndex = Math.max(0, resp.startIndex)

				firstItemIndexRef.current = nextFirstItemIndex
				clineMessagesLengthRef.current = converted.length
				setClineMessages(converted)
				setFirstItemIndex(nextFirstItemIndex)

				if (converted.length === 0) {
					pendingEdgeScrollRef.current = null
				}
			} catch (e) {
				pendingEdgeScrollRef.current = null
				console.error("fetchMessage:", e)
			} finally {
				if (edgeJumpInFlightRef.current === edge) {
					edgeJumpInFlightRef.current = null
				}
			}
		},
		[setClineMessages, setFirstItemIndex],
	)

	const handleRangeChanged = useCallback(
		(range: { startIndex: number; endIndex: number }) => {
			// When the webview is hidden, skip all range computations —
			// Virtuoso layout runs invisibly and wastes CPU across multiple panels.
			if (isWebviewHiddenRef.current) return

			if (clineMessagesLengthRef.current === 0) return
			if (renderRows.length === 0) return

			// Virtuoso reports this range in the coordinate given to
			// `firstItemIndex`, while `renderRows` is indexed from the start of the
			// loaded window. The range can also arrive a frame before the rows it
			// describes — or already expressed in window offsets — so it is clamped
			// rather than discarded: dropping it would silently stall the boundary
			// fetch that grows the loaded history.
			const lastRow = renderRows.length - 1
			const toLocalRow = (index: number) => Math.min(Math.max(index - rowCoordinate.firstItemIndex, 0), lastRow)
			const localStart = toLocalRow(range.startIndex)
			const localEnd = toLocalRow(range.endIndex)
			const firstVisibleRow = renderRows[localStart]
			const lastVisibleRow = renderRows[localEnd]

			if (!firstVisibleRow || !lastVisibleRow) return

			const window = currentMessageWindow()
			const visible: VisibleMessageRange = {
				firstMessageIndex: firstVisibleRow.startMessageIndex,
				lastMessageIndex: lastVisibleRow.endMessageIndex,
			}
			latestVisibleMessageRangeRef.current = visible
			latestVisibleAnchorTsRef.current = firstVisibleRow.startMessageTs ?? null
			captureBrowsingViewportAnchor()
			const allLoaded = isWholeConversationLoaded(window)
			const absoluteBottomLoaded = window.start + window.length >= window.total
			setShowScrollToBottom(disableAutoScrollRef.current || !absoluteBottomLoaded)

			// Range changes also fire while Virtuoso is establishing the initial
			// auto-follow position. Only explicit browsing intent may grow history;
			// otherwise those layout events eagerly fetch every leading page.
			if (!disableAutoScrollRef.current) {
				latestExtensionRangeRef.current = null
				return
			}

			if (allLoaded) {
				latestExtensionRangeRef.current = null
				return
			}

			// Grouping means a window with plenty of messages can still be a
			// couple of rows from its edge, so the row distance widens the
			// message-count rule rather than replacing it.
			const nearTopRow = localStart <= ROW_LOAD_THRESHOLD
			const nearBottomRow = renderRows.length - 1 - localEnd <= ROW_LOAD_THRESHOLD
			const rowUrgency: VisibleMessageRange = {
				firstMessageIndex: nearTopRow ? window.start : visible.firstMessageIndex,
				lastMessageIndex: nearBottomRow ? window.start + window.length - 1 : visible.lastMessageIndex,
			}

			latestExtensionRangeRef.current = rowUrgency
			requestWindowExtensions(rowUrgency, latestVisibleAnchorTsRef.current)
		},
		[
			captureBrowsingViewportAnchor,
			currentMessageWindow,
			renderRows,
			rowCoordinate.firstItemIndex,
			disableAutoScrollRef,
			setShowScrollToBottom,
			requestWindowExtensions,
		],
	)

	// A merge can leave the viewport inside the load threshold. Re-plan from the
	// last reported absolute range instead of waiting for Virtuoso to emit a new
	// range event, which it is not required to do after a state-only update.
	useEffect(() => {
		if (firstItemIndexRef.current !== firstItemIndex || clineMessagesLengthRef.current !== clineMessages.length) return

		const visible = latestExtensionRangeRef.current
		if (!visible) return
		requestWindowExtensions(visible, latestVisibleAnchorTsRef.current)
	}, [clineMessages.length, firstItemIndex, requestWindowExtensions])

	const virtuosoInstanceKey = `${task.ts}:${clineMessages.length === 0 ? "empty" : "loaded"}`

	// Floating button: scroll listener for visibility + wheel listener for direction.
	// Attached to Virtuoso inner scroller, not the outer scrollContainerRef.
	useEffect(() => {
		void virtuosoInstanceKey
		const container = scrollContainerRef.current
		if (!container) return

		const showButton = () => {
			if (hideBtnTimerRef.current) clearTimeout(hideBtnTimerRef.current)
			if (!isAtBottomRef.current || showScrollToBottomRef.current) {
				setFloatingBtnVisible(true)
				wasBtnShownRef.current = true
				hideBtnTimerRef.current = setTimeout(() => {
					setFloatingBtnVisible(false)
				}, 5000)
			}
		}

		const onScroll = () => {
			// Stamped here rather than in the range handler: a range change is a
			// consequence of scrolling and can also arrive without one, so it
			// cannot say whether the reader is currently moving the viewport.
			lastScrollAtRef.current = Date.now()
			scheduleDeferredWindowGrowth()
			showButton()
		}

		// Wheel event carries deltaY — use it to determine scroll direction
		const onWheel = (e: WheelEvent) => {
			if (Math.abs(e.deltaY) < 5) return // ignore micro-scrolls / trackpad noise
			const direction = e.deltaY < 0 ? "up" : "down"
			userScrollIntentRef.current = { direction, recordedAt: Date.now() }
			if (direction === "up") {
				// Capture browsing intent before Virtuoso publishes the resulting
				// range; otherwise one large wheel can reach the loaded top while the
				// range callback still believes auto-follow owns the viewport.
				disableAutoScrollRef.current = true
				cancelProgrammaticScroll()
			}
			setFloatingBtnDir(direction === "up" ? "top" : "bottom")
			showButton()
		}

		const el = container.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement | null
		if (el) {
			el.addEventListener("scroll", onScroll, { passive: true })
			el.addEventListener("wheel", onWheel, { passive: true })
		}

		return () => {
			if (el) {
				el.removeEventListener("scroll", onScroll)
				el.removeEventListener("wheel", onWheel)
			}
			if (hideBtnTimerRef.current) clearTimeout(hideBtnTimerRef.current)
		}
	}, [cancelProgrammaticScroll, disableAutoScrollRef, scrollContainerRef, isAtBottomRef, virtuosoInstanceKey])

	return (
		<div className="overflow-hidden flex flex-col h-full relative">
			<div
				className={cn(
					"absolute top-0 left-0 right-0 z-10 pl-[15px] pr-[14px] bg-background",
					scrolledPastUserMessage && "pb-2",
				)}>
				<StickyUserMessage
					isVisible={!!scrolledPastUserMessage}
					lastUserMessage={scrolledPastUserMessage}
					onScrollToMessage={handleScrollToUserMessage}
				/>
			</div>

			<div className="grow flex relative" ref={scrollContainerRef}>
				<Virtuoso
					atBottomStateChange={(atBottom) => {
						setIsAtBottom(atBottom)
						isAtBottomRef.current = atBottom

						const window = currentMessageWindow()
						const absoluteBottomLoaded = window.start + window.length >= window.total
						// Published so bottom restoration can tell the end of the
						// loaded window apart from the end of the conversation.
						absoluteBottomLoadedRef.current = absoluteBottomLoaded
						const userScrollIntent = userScrollIntentRef.current
						const userReachedBottom =
							atBottom &&
							userScrollIntent?.direction === "down" &&
							Date.now() - userScrollIntent.recordedAt <= USER_SCROLL_INTENT_TTL_MS
						if (absoluteBottomLoaded && userReachedBottom) {
							disableAutoScrollRef.current = false
							userScrollIntentRef.current = null
						}

						setShowScrollToBottom(!absoluteBottomLoaded || disableAutoScrollRef.current)

						if (atBottom && !absoluteBottomLoaded) {
							setFloatingBtnDir("bottom")
							setFloatingBtnVisible(true)
						}
					}}
					atBottomThreshold={10}
					className="scrollable grow overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
					components={virtuosoComponents}
					computeItemKey={computeItemKey}
					data={visibleGroupedMessages}
					firstItemIndex={rowCoordinate.firstItemIndex}
					increaseViewportBy={{ top: 400, bottom: 400 }}
					initialTopMostItemIndex={{ index: Math.max(visibleGroupedMessages.length - 1, 0), align: "end" }}
					itemContent={itemContent}
					itemsRendered={scheduleBrowsingViewportAnchorRestore}
					key={virtuosoInstanceKey}
					rangeChanged={handleRangeChanged}
					ref={virtuosoRef}
					scrollerRef={scrollerRef}
					// Browser scroll anchoring stays off.
					//
					// Not because the rows are positioned out of flow -- they are
					// static. The list expresses its virtual space as padding on
					// the item container, and per CSS Scroll Anchoring a padding
					// change anywhere between the anchor and the scroll container
					// is a suppression trigger, so the browser would abandon the
					// anchor on the very frames that need it. Leaving anchoring on
					// also competes with the library's own correction.
					style={{ overflowAnchor: "none" }}
					totalCount={visibleGroupedMessages.length}
					totalListHeightChanged={handleMeasuredLayoutChange}
				/>

				{/* Floating scroll direction button — appears on scroll, auto-hides after 5s idle */}
				{showScrollToBottom && (
					<div
						className={cn(
							"absolute bottom-4 right-4 z-20 transition-all duration-300 ease-out",
							floatingBtnVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
						)}>
						<button
							aria-label={floatingBtnDir === "bottom" ? "Scroll to bottom" : "Scroll to top"}
							className={cn(
								"w-10 h-10 rounded-full bg-background/65 backdrop-blur-sm shadow-md",
								"flex items-center justify-center cursor-pointer border-0",
								"hover:bg-background/90 hover:shadow-xl hover:scale-105",
								"active:scale-95 transition-all duration-200",
							)}
							onClick={() => {
								if (floatingBtnDir === "bottom") {
									userScrollIntentRef.current = null
									disableAutoScrollRef.current = false
									void jumpToEdge("bottom")
								} else {
									userScrollIntentRef.current = { direction: "up", recordedAt: Date.now() }
									disableAutoScrollRef.current = true
									void jumpToEdge("top")
								}
								if (hideBtnTimerRef.current) clearTimeout(hideBtnTimerRef.current)
								setFloatingBtnVisible(false)
							}}
							style={{
								animation: !wasBtnShownRef.current
									? undefined
									: floatingBtnVisible
										? "btnAppear 400ms cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards"
										: undefined,
							}}
							type="button">
							<span
								className={cn(
									"codicon text-base",
									floatingBtnDir === "bottom" ? "codicon-chevron-down" : "codicon-chevron-up",
								)}
							/>
						</button>
					</div>
				)}
			</div>

			{/* Button appear animation */}
			<style>{`
				@keyframes btnAppear {
					0% { transform: scale(0); opacity: 0; box-shadow: 0 0 0 0 rgba(0,0,0,0); }
					40% { transform: scale(1.4); opacity: 1; box-shadow: 0 0 16px 2px rgba(0,0,0,0.25); }
					70% { transform: scale(0.85); box-shadow: 0 0 8px 1px rgba(0,0,0,0.12); }
					100% { transform: scale(1); box-shadow: 0 1px 3px 1px rgba(0,0,0,0.08); }
				}
			`}</style>
		</div>
	)
}
