import { describe, expect, it } from "vitest"

import {
	DEFAULT_MESSAGE_WINDOW_LIMITS,
	isWholeConversationLoaded,
	leadingBuffer,
	type MessageWindow,
	planWindowExtensions,
	planWindowTrim,
	type VisibleMessageRange,
} from "./messageWindowPlan"

/**
 * Build a window whose viewport sits at a chosen offset inside it.
 *
 * @param start Absolute index of the first loaded message.
 * @param length Loaded message count.
 * @param total Total messages held by the backend.
 * @param viewportOffset Offset of the viewport inside the loaded window.
 * @param viewportSize Number of visible messages.
 * @returns Window bounds paired with the visible absolute range.
 */
function buildWindow(
	start: number,
	length: number,
	total: number,
	viewportOffset: number,
	viewportSize = 20,
): { window: MessageWindow; visible: VisibleMessageRange } {
	return {
		window: { start, length, total },
		visible: {
			firstMessageIndex: start + viewportOffset,
			lastMessageIndex: start + viewportOffset + viewportSize - 1,
		},
	}
}

describe("planWindowExtensions", () => {
	it("requests earlier messages when the leading buffer runs low", () => {
		const { window, visible } = buildWindow(500, 400, 2000, 10)

		const extensions = planWindowExtensions(window, visible)

		expect(extensions).toContainEqual({ side: "leading", startIndex: 300, count: 200 })
	})

	it("clamps the leading request at the start of the conversation", () => {
		const { window, visible } = buildWindow(50, 400, 2000, 10)

		const extensions = planWindowExtensions(window, visible)

		expect(extensions).toContainEqual({ side: "leading", startIndex: 0, count: 50 })
	})

	it("requests later messages when the trailing buffer runs low", () => {
		const { window, visible } = buildWindow(0, 400, 2000, 380)

		const extensions = planWindowExtensions(window, visible)

		expect(extensions).toContainEqual({ side: "trailing", startIndex: 400, count: 200 })
	})

	it("clamps the trailing request at the end of the conversation", () => {
		const { window, visible } = buildWindow(0, 400, 450, 380)

		const extensions = planWindowExtensions(window, visible)

		expect(extensions).toContainEqual({ side: "trailing", startIndex: 400, count: 50 })
	})

	it("asks for nothing once the whole conversation is loaded", () => {
		const { window, visible } = buildWindow(0, 120, 120, 0)

		expect(isWholeConversationLoaded(window)).toBe(true)
		expect(planWindowExtensions(window, visible)).toEqual([])
	})

	it("asks for nothing while both buffers are comfortable", () => {
		const { window, visible } = buildWindow(500, 800, 3000, 400)

		expect(planWindowExtensions(window, visible)).toEqual([])
	})
})

describe("planWindowTrim", () => {
	it("keeps a leading buffer that is still within the limit", () => {
		// leading = 300, trailing = 900 - 1 - 319 = 580: neither side exceeds
		// maxSideBuffer once the trailing side is also inside the limit.
		const { window, visible } = buildWindow(0, 500, 3000, 300)

		expect(planWindowTrim(window, visible)).toBeUndefined()
	})

	it("leaves the trim target behind when releasing the leading side", () => {
		const { window, visible } = buildWindow(0, 900, 3000, 500)

		const trim = planWindowTrim(window, visible)

		// Released down to the lower bound: 500 in reserve, 100 kept.
		expect(trim).toEqual({
			side: "leading",
			count: 400,
			nextStart: 400,
			nextLength: 500,
		})
	})

	it("leaves the trim target behind when releasing the trailing side", () => {
		// leading = 100, trailing = 900 - 1 - 119 = 780.
		const { window, visible } = buildWindow(0, 900, 3000, 100)

		const trim = planWindowTrim(window, visible)

		expect(trim).toEqual({
			side: "trailing",
			count: 680,
			nextStart: 0,
			nextLength: 220,
		})
	})

	it("releases exactly what a fetch adds, so the window cannot grow", () => {
		// The property the configuration exists for. A side sitting at the
		// upper bound is released back to the lower bound, and the distance
		// between the bounds is one fetch, so repeated browsing slides the
		// window instead of enlarging it.
		const { loadCount, loadThreshold, maxSideBuffer } = DEFAULT_MESSAGE_WINDOW_LIMITS
		expect(maxSideBuffer - loadThreshold).toBe(loadCount)

		// One message past the upper bound is the first state that releases.
		const { window, visible } = buildWindow(0, 900, 3000, maxSideBuffer + 1)
		const trim = planWindowTrim(window, visible)

		expect(trim?.count).toBe(maxSideBuffer + 1 - loadThreshold)
	})

	it("never releases into a state that immediately re-requests the same side", () => {
		const { window, visible } = buildWindow(1000, 900, 5000, 500)

		const trim = planWindowTrim(window, visible)
		expect(trim).toBeDefined()
		if (!trim) return

		const trimmed: MessageWindow = {
			start: trim.nextStart,
			length: trim.nextLength,
			total: window.total,
		}

		const followUp = planWindowExtensions(trimmed, visible)
		expect(followUp.some((extension) => extension.side === trim.side)).toBe(false)
	})

	it("refuses to trim when the configured target would re-arm loading", () => {
		const { window, visible } = buildWindow(0, 900, 3000, 500)

		// Below the fetch threshold the release would leave the side short
		// enough to request the messages back immediately.
		const trim = planWindowTrim(window, visible, {
			...DEFAULT_MESSAGE_WINDOW_LIMITS,
			trimSideTarget: DEFAULT_MESSAGE_WINDOW_LIMITS.loadThreshold - 1,
		})

		expect(trim).toBeUndefined()
	})

	it("releasing to the fetch threshold does not re-arm the fetch", () => {
		// The default configuration lands a release exactly on the threshold,
		// which an earlier revision refused outright. Refusing it is what let
		// the window grow, so the safety it was protecting is asserted here
		// directly: after the release the same side must not ask for more.
		//
		// `planWindowExtensions` fetches when the buffer is *below* the
		// threshold, so a side left exactly at it is satisfied.
		const { window, visible } = buildWindow(0, 900, 3000, 500)

		const trim = planWindowTrim(window, visible)
		expect(trim).toBeDefined()
		if (!trim) return

		const trimmed: MessageWindow = {
			start: trim.nextStart,
			length: trim.nextLength,
			total: window.total,
		}

		expect(leadingBuffer(trimmed, visible)).toBe(DEFAULT_MESSAGE_WINDOW_LIMITS.loadThreshold)
		expect(planWindowExtensions(trimmed, visible).some((extension) => extension.side === trim.side)).toBe(false)
	})
})
