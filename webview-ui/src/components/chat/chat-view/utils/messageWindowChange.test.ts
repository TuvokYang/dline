import { describe, expect, it } from "vitest"
import { isTailOnlyUpdate, type MessageIdentity } from "./messageWindowChange"

const rows = (...timestamps: number[]): MessageIdentity[] => timestamps.map((ts) => ({ ts }))

describe("isTailOnlyUpdate", () => {
	it("treats a streaming rewrite of the last message as a tail update", () => {
		expect(isTailOnlyUpdate(rows(1, 2, 3), rows(1, 2, 3))).toBe(true)
	})

	it("treats messages appended after the previous end as a tail update", () => {
		expect(isTailOnlyUpdate(rows(1, 2, 3), rows(1, 2, 3, 4, 5))).toBe(true)
	})

	it("rejects older history merged in at the top", () => {
		expect(isTailOnlyUpdate(rows(3, 4, 5), rows(1, 2, 3, 4, 5))).toBe(false)
	})

	it("rejects a window that slid forward", () => {
		expect(isTailOnlyUpdate(rows(1, 2, 3), rows(2, 3, 4))).toBe(false)
	})

	it("rejects a row removed before the previous end", () => {
		expect(isTailOnlyUpdate(rows(1, 2, 3, 4), rows(1, 3, 4, 5))).toBe(false)
	})

	it("rejects a window that shrank", () => {
		expect(isTailOnlyUpdate(rows(1, 2, 3), rows(1, 2))).toBe(false)
	})

	it("rejects the last message being replaced by a different one", () => {
		expect(isTailOnlyUpdate(rows(1, 2, 3), rows(1, 2, 9))).toBe(false)
	})

	it("rejects a change from an empty window", () => {
		expect(isTailOnlyUpdate(rows(), rows(1))).toBe(false)
	})
})
