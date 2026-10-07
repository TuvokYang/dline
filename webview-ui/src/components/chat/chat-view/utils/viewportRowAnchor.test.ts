import { afterEach, describe, expect, it, vi } from "vitest"
import { findFirstVisibleMessage } from "./viewportRowAnchor"

type Box = { top: number; height: number }
type RowSpec = Box & {
	/** Timestamp the row renders; omitted for rows such as tool groups. */
	ts?: number
	/** Offset of the message element inside its row. */
	inset?: number
}

const VIEWPORT: Box = { top: 100, height: 500 }

function toRect({ top, height }: Box): DOMRect {
	return { top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }
}

/** Build a scroller whose list rows report the given boxes, in DOM order. */
function createScroller(rows: RowSpec[]): HTMLElement {
	const scroller = document.createElement("div")
	const boxes = new Map<Element, Box>([[scroller, VIEWPORT]])
	rows.forEach((spec, index) => {
		const row = document.createElement("div")
		row.dataset.index = String(index)
		row.dataset.itemIndex = String(index + 1000)
		boxes.set(row, spec)
		const content = document.createElement("div")
		if (spec.ts !== undefined) content.dataset.messageTs = String(spec.ts)
		const inset = spec.inset ?? 0
		boxes.set(content, { top: spec.top + inset, height: spec.height - inset })
		row.appendChild(content)
		scroller.appendChild(row)
	})
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		return toRect(boxes.get(this) ?? { top: 0, height: 0 })
	})
	return scroller
}

describe("findFirstVisibleMessage", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("skips the overscan above the viewport and reports how far the first visible row is cut off", () => {
		const scroller = createScroller([
			{ ts: 3, top: -20, height: 50 },
			{ ts: 4, top: 30, height: 70 },
			{ ts: 5, top: 80, height: 50 },
			{ ts: 6, top: 130, height: 50 },
		])

		expect(findFirstVisibleMessage(scroller)).toEqual({ ts: 5, viewportOffset: -20 })
	})

	it("measures the list row rather than the message element inside it", () => {
		const scroller = createScroller([
			{ ts: 1, top: 112, height: 40, inset: 6 },
			{ ts: 2, top: 152, height: 40 },
		])

		expect(findFirstVisibleMessage(scroller)).toEqual({ ts: 1, viewportOffset: 12 })
	})

	it("anchors on the next message when the first visible row renders no single message", () => {
		const scroller = createScroller([
			{ top: 90, height: 40 },
			{ ts: 7, top: 130, height: 40 },
		])

		expect(findFirstVisibleMessage(scroller)).toEqual({ ts: 7, viewportOffset: 30 })
	})

	it("returns null when no message intersects the viewport", () => {
		const above = createScroller([{ ts: 1, top: 20, height: 80 }])
		expect(findFirstVisibleMessage(above)).toBeNull()
		vi.restoreAllMocks()

		const below = createScroller([{ ts: 1, top: 600, height: 80 }])
		expect(findFirstVisibleMessage(below)).toBeNull()
	})
})
