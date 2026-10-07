import type { Plugin } from "vite"

/**
 * The expression react-virtuoso 4.18.x uses to size its upward-scroll
 * compensation: the change of the whole list height (`O - k`).
 *
 * The whole height also changes when a row at or below the viewport resizes,
 * such as a streaming reply at the tail of the chat. Compensating for that as
 * if it happened above the viewport scrolls the reader by the tail's growth,
 * and near the end of the list a later, correct compensation for rows above is
 * clamped by the reduced scroll range — which shows as content jumping for one
 * painted frame and snapping back.
 */
const UPWARD_COMPENSATION_SOURCE = "(V = O - k, V !== 0 && (V += F))"

/**
 * The same expression, sized by how far the first row that starts at or below
 * the viewport top moved inside the list instead. That row moves by exactly the
 * size changes of the rows starting above the viewport top, which are the ones
 * the library means to compensate, so a row resizing in or below the viewport
 * no longer scrolls the reader. When the last rendered row straddles the
 * viewport top, that row is followed and its own growth is not compensated.
 * When the row cannot be followed across the update the library's own figure
 * is kept.
 *
 * In this scan `x` holds the previous rendered items, `p` the next ones, `O`
 * and `k` the next and previous list heights, and `ot(r)` reads the current
 * scroll top.
 */
const UPWARD_COMPENSATION_REPLACEMENT = "(V = __dlineViewportTopShift(x, p, ot(r), O - k), V !== 0 && (V += F))"

/** Implementation of the shift used by {@link UPWARD_COMPENSATION_REPLACEMENT}. */
export const VIEWPORT_TOP_SHIFT_HELPER = `
function __dlineViewportTopShift(previousItems, nextItems, scrollTop, wholeListChange) {
	const anchor =
		previousItems.find((item) => item.offset >= scrollTop) ??
		previousItems.find((item) => item.offset + item.size > scrollTop);
	if (!anchor) return wholeListChange;
	const moved = nextItems.find((item) => item.originalIndex === anchor.originalIndex);
	return moved ? moved.offset - anchor.offset : wholeListChange;
}
`

/**
 * Rewrite react-virtuoso's upward-scroll compensation to follow the row at the
 * top of the viewport.
 *
 * @param code Source of `react-virtuoso/dist/index.mjs`.
 * @returns The source with the compensation corrected.
 * @throws When the expected expression is not present exactly once, so a
 *   library upgrade that changes it fails the build instead of shipping the
 *   uncorrected behaviour silently.
 */
export function correctVirtuosoUpwardCompensation(code: string): string {
	const first = code.indexOf(UPWARD_COMPENSATION_SOURCE)
	if (first === -1 || code.indexOf(UPWARD_COMPENSATION_SOURCE, first + 1) !== -1) {
		throw new Error(
			"react-virtuoso upward-scroll compensation no longer matches the expected source; re-verify the correction in vite-virtuoso-upward-compensation.ts against the installed version.",
		)
	}
	return `${code.replace(UPWARD_COMPENSATION_SOURCE, UPWARD_COMPENSATION_REPLACEMENT)}\n${VIEWPORT_TOP_SHIFT_HELPER}`
}

/**
 * Apply {@link correctVirtuosoUpwardCompensation} to the bundled library.
 *
 * Applied at build time rather than by patching `node_modules`, which is shared
 * between worktrees. Dev-server dependency pre-bundling bypasses transforms, so
 * the correction covers production builds, which is what ships and what the
 * end-to-end suites run.
 */
export function virtuosoUpwardCompensationPlugin(): Plugin {
	return {
		name: "dline-virtuoso-upward-compensation",
		enforce: "pre",
		transform(code, id) {
			if (!/[\\/]react-virtuoso[\\/]dist[\\/]index\.mjs(\?|$)/.test(id)) return null
			return { code: correctVirtuosoUpwardCompensation(code), map: null }
		},
	}
}
