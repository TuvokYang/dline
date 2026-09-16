import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { advanceRowCoordinate, leadingRowShift, ROW_INDEX_BASE, rowIdentity } from "./rowCoordinate"

const message = (ts: number): ClineMessage => ({ ts }) as ClineMessage

const startingAt = (firstItemIndex: number, identities: string[]) => ({ firstItemIndex, identities })

describe("rowIdentity", () => {
	it("tells apart a row that regrouped from one that did not", () => {
		const before = rowIdentity([message(1), message(2)])
		const after = rowIdentity([message(1), message(2), message(3)])

		expect(rowIdentity([message(1), message(2)])).toBe(before)
		expect(after).not.toBe(before)
	})

	it("does not confuse a single message with a group that starts and ends on it", () => {
		expect(rowIdentity(message(7))).not.toBe(rowIdentity([message(7), message(7)]))
	})
})

describe("leadingRowShift", () => {
	it("reports how far known rows moved when history is loaded ahead of them", () => {
		const previous = ["10", "11", "12", "13"]
		const next = ["7", "8", "9", "10", "11", "12", "13"]

		expect(leadingRowShift(previous, next)).toBe(3)
	})

	it("reports a negative shift when rows are dropped from the front", () => {
		const previous = ["7", "8", "9", "10", "11", "12"]
		const next = ["9", "10", "11", "12"]

		expect(leadingRowShift(previous, next)).toBe(-2)
	})

	it("reports no shift when a reply is appended to the end", () => {
		const previous = ["1", "2", "3", "4"]
		const next = ["1", "2", "3", "4", "5"]

		expect(leadingRowShift(previous, next)).toBe(0)
	})

	it("still recognises the shift while the newest row is being streamed", () => {
		// The last row's identity changes on every token, and the first changes
		// as history arrives. Neither end is a reliable landmark on its own.
		const previous = ["10", "11", "12", "13", "partial-a"]
		const next = ["7", "8", "9", "10", "11", "12", "13", "partial-b"]

		expect(leadingRowShift(previous, next)).toBe(3)
	})

	it("refuses to guess when too few rows agree", () => {
		const previous = ["1", "2", "3", "4"]
		const next = ["4", "90", "91", "92"]

		expect(leadingRowShift(previous, next)).toBeNull()
	})

	it("refuses to guess when nothing is recognisable", () => {
		expect(leadingRowShift(["1", "2", "3"], ["90", "91", "92"])).toBeNull()
	})

	it("ignores rows whose identity appears twice", () => {
		// A repeated identity cannot say where anything went, so it must not be
		// counted towards agreement.
		const previous = ["dup", "1", "2"]
		const next = ["dup", "dup", "1", "2"]

		expect(leadingRowShift(previous, next)).toBeNull()
	})

	it("has nothing to compare against on the first render", () => {
		expect(leadingRowShift([], ["1", "2", "3"])).toBeNull()
		expect(leadingRowShift(["1", "2", "3"], [])).toBeNull()
	})
})

describe("advanceRowCoordinate", () => {
	it("moves the origin back by the number of rows loaded ahead", () => {
		const previous = startingAt(ROW_INDEX_BASE, ["10", "11", "12", "13"])
		const rows = [message(7), message(8), message(9), message(10), message(11), message(12), message(13)]

		expect(advanceRowCoordinate(previous, rows).firstItemIndex).toBe(ROW_INDEX_BASE - 3)
	})

	it("leaves the origin alone when rows are appended", () => {
		const previous = startingAt(ROW_INDEX_BASE - 3, ["1", "2", "3", "4"])
		const rows = [message(1), message(2), message(3), message(4), message(5)]

		expect(advanceRowCoordinate(previous, rows).firstItemIndex).toBe(ROW_INDEX_BASE - 3)
	})

	it("holds the origin still rather than resetting it when the window is unrecognisable", () => {
		// Resetting would itself be a large jump: the list reads the change as
		// the entire window moving, which is the jitter this coordinate exists
		// to prevent. Holding costs at most a re-measure.
		const previous = startingAt(ROW_INDEX_BASE - 191, ["1", "2", "3"])
		const rows = [message(500), message(501), message(502)]

		expect(advanceRowCoordinate(previous, rows).firstItemIndex).toBe(ROW_INDEX_BASE - 191)
	})

	it("keeps a row at the same coordinate across a window slide", () => {
		// The whole point: a row measured before the slide must still be found
		// at the coordinate the measurement was filed under.
		const previous = startingAt(ROW_INDEX_BASE, ["10", "11", "12", "13"])
		const coordinateOf = (state: { firstItemIndex: number; identities: string[] }, identity: string) =>
			state.firstItemIndex + state.identities.indexOf(identity)

		const before = coordinateOf(previous, "12")
		const rows = [message(7), message(8), message(9), message(10), message(11), message(12), message(13)]
		const next = advanceRowCoordinate(previous, rows)

		expect(coordinateOf(next, "12")).toBe(before)
	})

	it("records the identities it was given so the next comparison has a baseline", () => {
		const rows = [message(1), [message(2), message(3)]]

		expect(advanceRowCoordinate(startingAt(ROW_INDEX_BASE, []), rows).identities).toEqual(["1", "2,3"])
	})
})
