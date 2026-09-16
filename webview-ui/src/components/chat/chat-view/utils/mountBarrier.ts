/**
 * Hold an arriving row at the height the list expects while the reader scrolls.
 *
 * The transcript lurches because a virtual list resolves an arriving row in two
 * steps that land in different painted frames. Scrolling up, the padding that
 * stands in for the rows above shrinks by what the list currently *believes*
 * the arriving row is worth, while the row itself enters the normal flow at
 * what it *really* is. Everything below it moves by the difference for one
 * frame, and only afterwards does the measurement land and the list scroll back
 * to compensate.
 *
 * Measured on a seeded transcript: the padding released 66px for a row that
 * immediately occupied 431px, every row below it moved by 365px, and the
 * matching `scrollBy(+365)` arrived in the next animation-frame batch.
 *
 * Capping the row at the expected height during the scroll makes both steps
 * agree: the padding gives back exactly what the row takes, so there is no
 * difference left to paint and nothing for the list to undo. The cap is lifted
 * once the reader stops, when a single correction can be applied against a
 * known anchor instead of appearing mid-gesture.
 */

import { SCROLL_SETTLE_MS } from "./windowGrowthTiming"

/**
 * Whether a scroll gesture is still in progress.
 *
 * The library's own `isScrolling` cannot be used for this. It goes false about
 * 100ms after the last scroll event, which is shorter than the pauses inside a
 * single gesture: a reader turning a wheel, or a test driving one notch every
 * 45ms, repeatedly crosses that line. Releasing there puts the very layout
 * change being avoided back into the middle of the gesture, which is what a
 * measured attempt did — the jolt reappeared at a different moment rather than
 * disappearing.
 *
 * The project already decides when a scroll has settled, for deferring window
 * growth, and that window is reused here so both answer the question the same
 * way.
 *
 * @param msSinceLastScroll Milliseconds since the last scroll event, or null.
 * @returns True while the gesture should still be treated as running.
 */
export function isGestureActive(msSinceLastScroll: number | null): boolean {
	return msSinceLastScroll !== null && msSinceLastScroll < SCROLL_SETTLE_MS
}

/** Height the list believes a row has, or undefined when it is not known. */
export function expectedRowHeight(knownSize: unknown): number | undefined {
	const size =
		typeof knownSize === "string" ? Number.parseFloat(knownSize) : typeof knownSize === "number" ? knownSize : Number.NaN
	return Number.isFinite(size) && size > 0 ? size : undefined
}

/**
 * Decide whether an arriving row should be held at its expected height.
 *
 * Only rows the list has never measured are capped. A row it has already seen
 * carries a truthful size, so constraining it would hide content for no gain,
 * and a row that is currently taller than expected has already been paid for by
 * a correction that happened earlier.
 *
 * @param knownSize Value of the row wrapper's `data-known-size`.
 * @param scrolling Whether the list reports an active scroll.
 * @param measured Whether this row has been measured since it was mounted.
 * @returns The height to hold the row at, or undefined to leave it alone.
 */
export function heightToHold(knownSize: unknown, scrolling: boolean, measured: boolean): number | undefined {
	if (!scrolling || measured) return undefined
	return expectedRowHeight(knownSize)
}
