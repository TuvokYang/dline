/** A message the reader can see, and where the top of its list row sits in the viewport. */
export type ViewportMessageAnchor = {
	/** Timestamp identity of the message, as rendered in `data-message-ts`. */
	ts: number
	/** Distance from the viewport top to the row top; negative when the row starts above it. */
	viewportOffset: number
}

const MESSAGE_SELECTOR = "[data-message-ts]"
/** Item wrappers the virtual list renders; only they carry `data-item-index`. */
const LIST_ROW_SELECTOR = "[data-item-index]"

/**
 * Find the first rendered message whose list row intersects the scroller's viewport.
 *
 * The list renders an overscan band beyond both edges of the viewport, so the
 * first rendered row is usually one the reader cannot see; this reads the
 * layout instead. The message is identified by the timestamp the row renders
 * rather than by its list index, because the index of a rendered row can lag
 * the data for a frame after older history is merged in. Rows that render no
 * single message, such as tool groups, are skipped in favour of the next one.
 *
 * @param scroller Scroll container that hosts the list rows.
 * @returns The first visible message, or null when none intersects the viewport.
 */
export function findFirstVisibleMessage(scroller: HTMLElement): ViewportMessageAnchor | null {
	const viewport = scroller.getBoundingClientRect()
	for (const element of scroller.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)) {
		// The row, not the message element, is what the list aligns when it
		// scrolls to an index, so its edge is the one to measure.
		const row = element.closest<HTMLElement>(LIST_ROW_SELECTOR) ?? element
		const bounds = row.getBoundingClientRect()
		if (bounds.height <= 0 || bounds.bottom <= viewport.top) continue
		if (bounds.top >= viewport.bottom) return null

		const ts = Number(element.dataset.messageTs)
		if (!Number.isFinite(ts)) continue
		return { ts, viewportOffset: bounds.top - viewport.top }
	}
	return null
}
