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
 * Set on every rendered chat row, grouped ones included, to the ts of the
 * row's first message. It places a row in the conversation; unlike
 * `data-message-ts` it does not name a message a browsing anchor can restore.
 */
export const ROW_TS_ATTRIBUTE = "data-row-ts"
const ROW_SELECTOR = `[${ROW_TS_ATTRIBUTE}]`

type VisibleOptions = { minVisiblePx?: number }

function firstVisible(
    scroller: HTMLElement,
    selector: string,
    readTs: (element: HTMLElement) => number,
    { minVisiblePx = 0 }: VisibleOptions,
): ViewportMessageAnchor | null {
    const viewport = scroller.getBoundingClientRect()
    for (const element of scroller.querySelectorAll<HTMLElement>(selector)) {
        // The row, not the message element, is what the list aligns when it
        // scrolls to an index, so its edge is the one to measure.
        const row = element.closest<HTMLElement>(LIST_ROW_SELECTOR) ?? element
        const bounds = row.getBoundingClientRect()
        if (bounds.height <= 0 || bounds.bottom <= viewport.top + minVisiblePx) continue
        if (bounds.top >= viewport.bottom) return null

        const ts = readTs(element)
        if (!Number.isFinite(ts)) continue
        return { ts, viewportOffset: bounds.top - viewport.top }
    }
    return null
}

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
 * @param options.minVisiblePx How much of a row must show below the viewport top
 *   for it to count; rows showing less are skipped. Defaults to any overlap.
 * @returns The first visible message, or null when none intersects the viewport.
 */
export function findFirstVisibleMessage(scroller: HTMLElement, options: VisibleOptions = {}): ViewportMessageAnchor | null {
    return firstVisible(scroller, MESSAGE_SELECTOR, (element) => Number(element.dataset.messageTs), options)
}

/**
 * Find the first rendered row of any kind whose list row intersects the viewport.
 *
 * Unlike `findFirstVisibleMessage`, grouped rows such as tool groups count, and
 * are identified by the ts of their first message. That places the reader in
 * the conversation; it is not an anchor to restore a scroll position to.
 *
 * @returns The first visible row's ts and offset, or null when none intersects the viewport.
 */
export function findFirstVisibleRow(scroller: HTMLElement, options: VisibleOptions = {}): ViewportMessageAnchor | null {
    return firstVisible(scroller, ROW_SELECTOR, (element) => Number(element.getAttribute(ROW_TS_ATTRIBUTE)), options)
}
