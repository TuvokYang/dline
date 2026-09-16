import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { isGestureActive } from "../utils/mountBarrier"
import { SCROLL_SETTLE_MS } from "../utils/windowGrowthTiming"

/**
 * Keep an arriving row from claiming more space than the list gave back.
 *
 * Scrolling through history with the task idle, a row that has never been
 * measured arrives in two disagreeing steps. The padding standing in for the
 * rows above shrinks by the size the list remembers — measured at 66px — while
 * the row enters the normal flow at what it really is, 431px. The difference is
 * painted immediately, and only in the next animation-frame batch does the
 * measurement land and the list scroll back by the same amount. That pair is
 * the tremor: the transcript lurches, then snaps back.
 *
 * Holding such a row at the remembered size makes the two steps agree, so the
 * difference never reaches the screen and there is nothing to undo. The hold
 * lasts for the whole gesture, and is lifted in a single layout pass that also
 * pays back the difference, so releasing is not visible either.
 */
export interface MountBarrier {
	/** True while arriving rows should be held at their remembered size. */
	held: boolean
	/** Record that the list has measured this row, so it no longer needs holding. */
	markMeasured: (itemIndex: string) => void
	/** Whether this row has been measured since it mounted. */
	hasMeasured: (itemIndex: string) => boolean
	/** Drop the barrier now, for navigation that owns the position itself. */
	release: () => void
}

/**
 * @param scroller The scrolling element, once it exists.
 * @param anchorTop Reads the viewport position the release must preserve.
 * @returns The barrier state and the hooks the row wrapper needs.
 */
export function useMountBarrier(scroller: HTMLElement | null, anchorTop: () => number | null): MountBarrier {
	const [held, setHeld] = useState(false)
	const lastScrollAtRef = useRef<number | null>(null)
	const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	// Outside React state deliberately: this is read while rendering every row
	// and written whenever the list measures one, so keeping it in state would
	// re-render the whole transcript on each measurement.
	const measuredRef = useRef(new Set<string>())
	// Read through a ref so a caller passing a fresh closure each render cannot
	// re-trigger the release below.
	const anchorTopRef = useRef(anchorTop)
	anchorTopRef.current = anchorTop
	// Only a barrier that was actually up has anything to pay back, and it must
	// be paid exactly once. Without this the release also runs on the first
	// render, correcting against a difference no hold produced.
	const wasHeldRef = useRef(false)

	const markMeasured = useCallback((itemIndex: string) => {
		measuredRef.current.add(itemIndex)
	}, [])

	const hasMeasured = useCallback((itemIndex: string) => measuredRef.current.has(itemIndex), [])

	const release = useCallback(() => {
		if (settleTimerRef.current !== null) {
			clearTimeout(settleTimerRef.current)
			settleTimerRef.current = null
		}
		lastScrollAtRef.current = null
		// Dropped without paying anything back: the caller is navigating and
		// owns where the viewport lands, so a correction measured against the
		// row that happened to be on screen would fight it.
		wasHeldRef.current = false
		setHeld(false)
	}, [])

	useEffect(() => {
		if (!scroller) return

		const settle = () => {
			settleTimerRef.current = null
			if (isGestureActive(elapsed())) {
				// Another event arrived while the timer was pending; wait out the
				// remainder rather than releasing inside the gesture.
				arm()
				return
			}
			setHeld(false)
		}

		const elapsed = (): number | null => {
			const last = lastScrollAtRef.current
			return last === null ? null : performance.now() - last
		}

		const arm = () => {
			if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current)
			settleTimerRef.current = setTimeout(settle, SCROLL_SETTLE_MS)
		}

		const onActivity = () => {
			lastScrollAtRef.current = performance.now()
			setHeld(true)
			arm()
		}

		// Every way the reader can move the list. `scroll` alone is not enough:
		// it fires after the fact, and the barrier has to be up before the list
		// mounts the row that the scroll brought into range.
		scroller.addEventListener("scroll", onActivity, { passive: true })
		scroller.addEventListener("wheel", onActivity, { passive: true })
		scroller.addEventListener("touchmove", onActivity, { passive: true })
		scroller.addEventListener("keydown", onActivity)
		return () => {
			scroller.removeEventListener("scroll", onActivity)
			scroller.removeEventListener("wheel", onActivity)
			scroller.removeEventListener("touchmove", onActivity)
			scroller.removeEventListener("keydown", onActivity)
			if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current)
			settleTimerRef.current = null
		}
	}, [scroller])

	// Pay back the space the released rows take, before anything is painted.
	//
	// Both measurements and the correction happen inside one layout pass: the
	// browser does not paint between them, so the anchor never moves on screen.
	// Going through the scroll arbiter instead would defer the correction to the
	// next animation frame, which is precisely the defect being fixed.
	useLayoutEffect(() => {
		if (held) {
			wasHeldRef.current = true
			return
		}
		if (!wasHeldRef.current || !scroller) return
		wasHeldRef.current = false

		const before = anchorTopRef.current()
		if (before === null) return
		// Reading a layout property flushes the pending style change, so the
		// second reading already reflects the released rows.
		void scroller.scrollHeight
		const after = anchorTopRef.current()
		if (after === null) return
		const drift = after - before
		if (Math.abs(drift) > 0.5) scroller.scrollTop += drift
	}, [held, scroller])

	// A row measured under one set of heights says nothing about the next task.
	useEffect(() => {
		measuredRef.current = new Set<string>()
	}, [scroller])

	return { held, markMeasured, hasMeasured, release }
}
