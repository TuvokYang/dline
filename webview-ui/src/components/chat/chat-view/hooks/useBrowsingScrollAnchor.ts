import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import type { ScrollBehavior } from "../types/chatTypes"
import { isTailOnlyUpdate, type MessageIdentity } from "../utils/messageWindowChange"

type Anchor = { ts: string; top: number }

/** Preserve layout shifts, never undo a newer user scroll within the same virtual range. */
export function useBrowsingScrollAnchor(
	messages: readonly MessageIdentity[],
	taskKey: string | number | undefined,
	scroller: HTMLElement | null,
	{ disableAutoScrollRef, requestProgrammaticScroll, virtuosoRef }: ScrollBehavior,
) {
	const anchorRef = useRef<Anchor | null>(null)
	const pendingRef = useRef(false)
	const contentChangeRef = useRef(false)
	const epochRef = useRef(0)
	const previousMessagesRef = useRef(messages)

	const invalidate = useCallback(() => {
		epochRef.current += 1
		pendingRef.current = false
		contentChangeRef.current = false
		anchorRef.current = null
	}, [])

	const capture = useCallback(
		(fromScroll = false) => {
			if (!scroller || !disableAutoScrollRef.current || pendingRef.current) return
			if (!fromScroll && anchorRef.current) return
			const bounds = scroller.getBoundingClientRect()
			const visible = [...scroller.querySelectorAll<HTMLElement>("[data-message-ts]")].filter((element) => {
				const rect = element.getBoundingClientRect()
				return rect.bottom > bounds.top && rect.top < bounds.bottom
			})
			const element = visible[Math.floor(visible.length / 2)]
			const ts = element?.dataset.messageTs
			anchorRef.current = element && ts ? { ts, top: element.getBoundingClientRect().top - bounds.top } : null
		},
		[disableAutoScrollRef, scroller],
	)

	const scheduleRestore = useCallback(() => {
		if (!contentChangeRef.current || !anchorRef.current || !scroller) return
		if (!disableAutoScrollRef.current) {
			invalidate()
			return
		}
		pendingRef.current = true
		const epoch = epochRef.current
		requestProgrammaticScroll({
			priority: "passive",
			isStillWanted: () => epoch === epochRef.current && disableAutoScrollRef.current && pendingRef.current,
			run: () => {
				const anchor = anchorRef.current
				const element = anchor ? scroller.querySelector<HTMLElement>(`[data-message-ts="${anchor.ts}"]`) : null
				pendingRef.current = false
				if (!anchor || !element) return
				const delta = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top
				if (Math.abs(delta) > 0.5) virtuosoRef.current?.scrollBy({ top: delta, behavior: "auto" })
			},
		})
	}, [disableAutoScrollRef, invalidate, requestProgrammaticScroll, scroller, virtuosoRef])

	useLayoutEffect(() => {
		void taskKey
		invalidate()
		return invalidate
	}, [invalidate, taskKey])

	useLayoutEffect(() => {
		const previous = previousMessagesRef.current
		previousMessagesRef.current = messages
		// A reply streaming in only rewrites or extends the end of the window,
		// which cannot move the rows being read; the list compensates any row
		// above that changes size. Restoring here would undo the reader's own
		// scroll that is still in flight.
		if (isTailOnlyUpdate(previous, messages)) return
		if (disableAutoScrollRef.current && anchorRef.current) {
			contentChangeRef.current = true
			scheduleRestore()
		}
	}, [disableAutoScrollRef, messages, scheduleRestore])

	useEffect(() => {
		if (!scroller) return
		// Virtual range changes are not pixel scroll events. Track both so a
		// transport refresh cannot restore the position from the previous row range.
		const onScroll = () => {
			// Only restore a content-update anchor. For ordinary user scrolling,
			// Virtuoso owns measurement compensation; undoing it causes a second jump.
			if (contentChangeRef.current) {
				scheduleRestore()
				return
			}
			capture(true)
		}
		scroller.addEventListener("scroll", onScroll, { passive: true })
		scroller.addEventListener("wheel", invalidate, { passive: true })
		scroller.addEventListener("touchstart", invalidate, { passive: true })
		scroller.addEventListener("pointerdown", invalidate, { passive: true })
		scroller.addEventListener("keydown", invalidate)
		return () => {
			scroller.removeEventListener("scroll", onScroll)
			scroller.removeEventListener("wheel", invalidate)
			scroller.removeEventListener("touchstart", invalidate)
			scroller.removeEventListener("pointerdown", invalidate)
			scroller.removeEventListener("keydown", invalidate)
			invalidate()
		}
	}, [capture, invalidate, scheduleRestore, scroller])

	// Another writer has taken over the position for the current content change
	// (the list's own scroll-to-index after older history merges in). A second
	// correction measured while that one is still settling would interrupt it,
	// so drop the pending restore and let the next scroll capture afresh.
	const release = invalidate

	return { capture, scheduleRestore, release }
}
