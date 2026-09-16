/**
 * Sliding-window arithmetic for the virtualized chat list.
 *
 * The window is a contiguous slice `[start, start + length)` of the backend
 * conversation. Deciding when to extend it and when to release the far side
 * used to live inline in the component, split across a range handler and a
 * trim effect that measured the same distances differently. The two could
 * therefore ask for a fetch and release the result on the same frame, which
 * the user sees as a list that reloads forever and refuses to move.
 *
 * Keeping the arithmetic here makes the invariant explicit and testable: a
 * window is only trimmed down to a size that still satisfies the load
 * threshold, so a trim can never re-arm the fetch it just satisfied.
 */

/** Absolute bounds of the currently loaded message window. */
export interface MessageWindow {
	/** Absolute index of the first loaded message. */
	start: number
	/** Number of loaded messages. */
	length: number
	/** Total messages the backend holds for this task. */
	total: number
}

/** Absolute message indexes currently on screen. */
export interface VisibleMessageRange {
	/** Absolute index of the first visible message. */
	firstMessageIndex: number
	/** Absolute index of the last visible message. */
	lastMessageIndex: number
}

/** Tuning for window growth and release. */
export interface MessageWindowLimits {
	/** Messages to request per extension. */
	loadCount: number
	/** Buffer below which an extension is requested. */
	loadThreshold: number
	/** Buffer above which the far side may be released. */
	maxSideBuffer: number
	/** Buffer left behind after a release. */
	trimSideTarget: number
}

/**
 * The window is a fixed-size slice, not a growing one.
 *
 * Each side keeps between `loadThreshold` and `maxSideBuffer` messages in
 * reserve. Falling to the lower bound fetches `loadCount`, taking that side
 * back to the upper bound; rising above the upper bound releases the same
 * `loadCount`, taking it back to the lower bound. Growth and release are
 * therefore equal and opposite, so browsing a long conversation slides the
 * window rather than enlarging it, and the number of mounted rows does not
 * follow the length of the transcript.
 *
 * The gap between the two bounds is the hysteresis: it is exactly one
 * `loadCount` wide, so a fetch cannot immediately satisfy the release rule
 * nor a release immediately re-arm the fetch. An earlier configuration
 * released only `maxSideBuffer - trimSideTarget` — 120 against a fetch of
 * 200 — which left a net gain of 80 messages on every cycle and let the
 * window creep upward for the whole session.
 */

/** One side of the window. */
export type WindowSide = "leading" | "trailing"

/** A request to extend the window on one side. */
export interface WindowExtension {
	side: WindowSide
	/** Absolute index the fetch starts from. */
	startIndex: number
	/** Number of messages to fetch. */
	count: number
}

/** A request to release messages from one side of the window. */
export interface WindowTrim {
	side: WindowSide
	/** Number of messages to drop. */
	count: number
	/** Window start after the trim is applied. */
	nextStart: number
	/** Window length after the trim is applied. */
	nextLength: number
}

/** Default limits used by the chat message list. */
export const DEFAULT_MESSAGE_WINDOW_LIMITS: MessageWindowLimits = {
	loadCount: 200,
	loadThreshold: 100,
	maxSideBuffer: 300,
	trimSideTarget: 100,
}

/**
 * Report whether the window already spans the whole conversation.
 *
 * @param window Current window bounds.
 * @returns True when no further extension is possible.
 */
export function isWholeConversationLoaded(window: MessageWindow): boolean {
	return window.start <= 0 && window.start + window.length >= window.total
}

/**
 * Count loaded messages above the viewport.
 *
 * @param window Current window bounds.
 * @param visible Absolute indexes on screen.
 * @returns Number of loaded messages before the first visible one.
 */
export function leadingBuffer(window: MessageWindow, visible: VisibleMessageRange): number {
	return Math.max(0, visible.firstMessageIndex - window.start)
}

/**
 * Count loaded messages below the viewport.
 *
 * @param window Current window bounds.
 * @param visible Absolute indexes on screen.
 * @returns Number of loaded messages after the last visible one.
 */
export function trailingBuffer(window: MessageWindow, visible: VisibleMessageRange): number {
	return Math.max(0, window.start + window.length - 1 - visible.lastMessageIndex)
}

/**
 * Decide which side of the window, if any, must be extended.
 *
 * @param window Current window bounds.
 * @param visible Absolute indexes on screen.
 * @param limits Growth and release tuning.
 * @returns Extensions to request, in priority order.
 */
export function planWindowExtensions(
	window: MessageWindow,
	visible: VisibleMessageRange,
	limits: MessageWindowLimits = DEFAULT_MESSAGE_WINDOW_LIMITS,
): WindowExtension[] {
	const extensions: WindowExtension[] = []

	if (window.start > 0 && leadingBuffer(window, visible) < limits.loadThreshold) {
		const startIndex = Math.max(0, window.start - limits.loadCount)
		const count = window.start - startIndex
		if (count > 0) {
			extensions.push({ side: "leading", startIndex, count })
		}
	}

	const windowEnd = window.start + window.length
	if (windowEnd < window.total && trailingBuffer(window, visible) < limits.loadThreshold) {
		const count = Math.min(limits.loadCount, window.total - windowEnd)
		if (count > 0) {
			extensions.push({ side: "trailing", startIndex: windowEnd, count })
		}
	}

	return extensions
}

/**
 * Decide whether the window may release messages on its far side.
 *
 * A trim is only proposed when the remaining buffer still exceeds the load
 * threshold. Without that guard the release immediately satisfies the
 * extension rule again and the window oscillates.
 *
 * @param window Current window bounds.
 * @param visible Absolute indexes on screen.
 * @param limits Growth and release tuning.
 * @returns Trim to apply, or undefined when the window should be left alone.
 */
export function planWindowTrim(
	window: MessageWindow,
	visible: VisibleMessageRange,
	limits: MessageWindowLimits = DEFAULT_MESSAGE_WINDOW_LIMITS,
): WindowTrim | undefined {
	// Releasing below the fetch threshold would re-arm the fetch that the
	// release just satisfied, so the target may reach that threshold but not
	// pass it. Landing exactly on it is the intended steady state: the side
	// is left at the lower bound with a full `loadCount` of headroom before
	// either rule fires again.
	if (limits.trimSideTarget < limits.loadThreshold) {
		return undefined
	}

	const leading = leadingBuffer(window, visible)
	if (leading > limits.maxSideBuffer) {
		const count = Math.min(leading - limits.trimSideTarget, window.length)
		if (count > 0) {
			return {
				side: "leading",
				count,
				nextStart: window.start + count,
				nextLength: window.length - count,
			}
		}
	}

	const trailing = trailingBuffer(window, visible)
	if (trailing > limits.maxSideBuffer) {
		const count = Math.min(trailing - limits.trimSideTarget, window.length)
		if (count > 0) {
			return {
				side: "trailing",
				count,
				nextStart: window.start,
				nextLength: window.length - count,
			}
		}
	}

	return undefined
}
