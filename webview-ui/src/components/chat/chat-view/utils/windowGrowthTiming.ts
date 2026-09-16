/**
 * When the loaded message window may grow or shrink.
 *
 * Extending the window while the reader is scrolling changes the content above
 * the viewport: rows are added at the leading edge and released from the far
 * side, and every remembered size shifts with them. Measured during a scroll,
 * that arrives as the scroll height changing by a few hundred pixels between
 * two frames, which the reader sees as the transcript sliding under them.
 *
 * Deferring the change until the scroll settles keeps that movement out of the
 * frames the reader is watching. It cannot be deferred unconditionally: a
 * reader who scrolls continuously toward an edge would reach the end of what is
 * loaded and find nothing there. So a request that is close enough to an edge
 * to be needed now is allowed through, and everything else waits.
 */

/** How long after the last scroll event the viewport is considered settled. */
export const SCROLL_SETTLE_MS = 180

/**
 * Messages left between the viewport and the loaded edge before growth is
 * urgent.
 *
 * Below this the reader is about to run out of transcript, so the fetch has to
 * happen even mid-scroll; the alternative is an empty viewport. Above it the
 * fetch is speculative and can wait for the scroll to stop.
 *
 * The unit is messages, matching `leadingBuffer`/`trailingBuffer`. It is well
 * under the window planner's own load threshold so that deferring never
 * competes with the decision to fetch at all: by the time the buffer is this
 * small, the planner has been asking for a while.
 */
export const URGENT_MESSAGE_DISTANCE = 20

export interface WindowGrowthSignals {
	/** Milliseconds since the last scroll event, or null when never scrolled. */
	msSinceLastScroll: number | null
	/** Messages between the viewport and the start of the loaded window. */
	messagesToLeadingEdge: number
	/** Messages between the viewport and the end of the loaded window. */
	messagesToTrailingEdge: number
}

export type WindowGrowthDecision = "run" | "defer"

/**
 * Decide whether a window extension may run now.
 *
 * @param signals Scroll recency and distance to each loaded edge.
 * @returns `run` to fetch immediately, `defer` to wait for the scroll to stop.
 */
export function decideWindowGrowth(signals: WindowGrowthSignals): WindowGrowthDecision {
	const { msSinceLastScroll, messagesToLeadingEdge, messagesToTrailingEdge } = signals

	// Never scrolled, or the scroll already settled: nothing is being watched
	// closely enough for a size change to register as movement.
	if (msSinceLastScroll === null || msSinceLastScroll >= SCROLL_SETTLE_MS) return "run"

	// Running out of loaded messages outranks smoothness. A deferred fetch here
	// would show the reader the end of the window instead of the conversation.
	const nearestEdge = Math.min(messagesToLeadingEdge, messagesToTrailingEdge)
	if (nearestEdge <= URGENT_MESSAGE_DISTANCE) return "run"

	return "defer"
}
