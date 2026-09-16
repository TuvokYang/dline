/**
 * Single owner of programmatic chat scrolls.
 *
 * The chat used to issue scroll commands from four independent places: the
 * streaming auto-scroll, the row height observer, the visibility restore and
 * the edge jump. Each of them queued its own animation frame plus a private
 * chain of retry timers, and none of them could cancel another. Overlapping
 * chains kept re-targeting Virtuoso while the user was still scrolling, which
 * is what produced the visible bounce and the "list refuses to move" feeling.
 *
 * Routing every request through one arbiter guarantees at most one pending
 * chain exists at a time. Priorities prevent passive row-growth updates from
 * cancelling an explicit navigation or a layout-settle chain.
 */

/** Relative importance of a programmatic scroll request. */
export type ScrollRequestPriority = "passive" | "layout" | "user"

const SCROLL_PRIORITY_RANK: Record<ScrollRequestPriority, number> = {
	passive: 0,
	layout: 1,
	user: 2,
}

/** Scroll request accepted by the arbiter. */
export interface ScrollRequest {
	/** Runs the actual scroll. Called once per attempt. */
	run: () => void
	/** Prevents a lower-priority request from replacing this chain. */
	priority?: ScrollRequestPriority
	/**
	 * Extra attempts after the initial frame, in milliseconds.
	 *
	 * Virtuoso can settle its layout after the first frame (images, code
	 * blocks, a restored panel), so a bottom-follow needs a short retry chain.
	 * Ordinary follow-ups during streaming should pass an empty list.
	 */
	retryDelaysMs?: readonly number[]
	/** Aborts the request and any pending retry when it returns false. */
	isStillWanted?: () => boolean
}

/** Cancellable handle over the arbiter's pending work. */
export interface ScrollArbiter {
	/** Replaces any pending scroll with this request. */
	request: (request: ScrollRequest) => void
	/** Drops pending work without scheduling anything new. */
	cancel: () => void
}

/**
 * Create a scroll arbiter that keeps at most one pending scroll chain.
 *
 * @returns Arbiter whose `request` supersedes any previously pending scroll.
 */
export function createScrollArbiter(): ScrollArbiter {
	let frameId: number | null = null
	let timers: ReturnType<typeof setTimeout>[] = []
	let activePriority: ScrollRequestPriority | null = null
	let requestVersion = 0

	const cancel = (): void => {
		requestVersion += 1
		if (frameId !== null) {
			cancelAnimationFrame(frameId)
			frameId = null
		}
		for (const timer of timers) {
			clearTimeout(timer)
		}
		timers = []
		activePriority = null
	}

	const request = (scrollRequest: ScrollRequest): void => {
		const priority = scrollRequest.priority ?? "passive"
		if (activePriority !== null && SCROLL_PRIORITY_RANK[priority] < SCROLL_PRIORITY_RANK[activePriority]) {
			return
		}

		cancel()
		activePriority = priority
		const version = requestVersion
		const retryDelaysMs = scrollRequest.retryDelaysMs ?? []
		let remainingAttempts = retryDelaysMs.length + 1

		const attempt = () => {
			if (version !== requestVersion) return
			if (scrollRequest.isStillWanted && !scrollRequest.isStillWanted()) {
				cancel()
				return
			}
			// Announce that the next scroll write belongs to the application.
			//
			// The application and react-virtuoso's own compensation both end up
			// calling the same scroller method, so a stack captured there names
			// only the shared exit. `run()` is synchronous and is the single
			// place every arbitrated scroll passes through, so a mark taken here
			// lets a diagnostic tell the two apart. No-op unless a harness has
			// installed the hook.
			;(window as { __dlineMarkAppScroll?: () => void }).__dlineMarkAppScroll?.()
			scrollRequest.run()
			remainingAttempts -= 1
			if (remainingAttempts === 0 && version === requestVersion) {
				activePriority = null
				timers = []
			}
		}

		frameId = requestAnimationFrame(() => {
			frameId = null
			attempt()
		})

		if (retryDelaysMs.length > 0) {
			timers = retryDelaysMs.map((delay) => setTimeout(attempt, delay))
		}
	}

	return { request, cancel }
}

/** Retry chain used when layout is expected to settle late (restore, edge jump). */
export const LAYOUT_SETTLE_RETRY_MS: readonly number[] = [50, 200, 500]
