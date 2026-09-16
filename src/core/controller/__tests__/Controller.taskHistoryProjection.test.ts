import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import { Controller } from "../index"

/**
 * Behavior guard for reusing the history projection across state publications.
 *
 * `HistoryItem.task` holds the verbatim task text, so the projection shortens
 * it before the entry is broadcast. Sorting and projecting the whole list on
 * every publication repeated that work even when the history had not changed,
 * and an idle task publishes state continuously.
 *
 * The cached history is replaced wholesale rather than mutated on every update
 * path, so the array reference identifies its contents.
 */

/**
 * Reaches the private projection directly.
 *
 * Driving it through a full state build would require standing up every
 * collaborator `buildState` touches, and a stub resolving first could mask the
 * very reuse under test.
 */
interface ProjectingController {
	projectTaskHistoryCached(history: readonly HistoryItem[] | undefined): Array<{ id: string }>
}

function createController(): ProjectingController {
	return Object.create(Controller.prototype) as unknown as ProjectingController
}

function createItem(id: string, ts: number): HistoryItem {
	return {
		id,
		ulid: `ulid-${id}`,
		ts,
		task: `task text for ${id}`,
		tokensIn: 1,
		tokensOut: 1,
		cacheWrites: 0,
		cacheReads: 0,
		totalCost: 0,
		size: 0,
	} as HistoryItem
}

describe("Controller task history projection", () => {
	it("returns the same projection instance for the same history array", () => {
		const controller = createController()
		const history = [createItem("a", 1_000), createItem("b", 2_000)]

		const first = controller.projectTaskHistoryCached(history)
		const second = controller.projectTaskHistoryCached(history)

		expect(second).toBe(first)
	})

	it("reprojects when the history array is replaced", () => {
		const controller = createController()
		const history = [createItem("a", 1_000)]
		const first = controller.projectTaskHistoryCached(history)

		// Every update path allocates a new array rather than mutating in place.
		const updated = [...history, createItem("b", 2_000)]
		const second = controller.projectTaskHistoryCached(updated)

		expect(second).not.toBe(first)
		expect(second.map((entry) => entry.id)).toEqual(["b", "a"])
	})

	it("orders entries newest first", () => {
		const controller = createController()

		const projected = controller.projectTaskHistoryCached([
			createItem("older", 1_000),
			createItem("newest", 3_000),
			createItem("middle", 2_000),
		])

		expect(projected.map((entry) => entry.id)).toEqual(["newest", "middle", "older"])
	})

	it("does not reorder the array it was given", () => {
		const controller = createController()
		const history = [createItem("older", 1_000), createItem("newest", 3_000)]

		controller.projectTaskHistoryCached(history)

		expect(history.map((entry) => entry.id)).toEqual(["older", "newest"])
	})

	it("treats a missing history as empty", () => {
		const controller = createController()

		// A missing history has no array to key on, so each call substitutes a
		// fresh empty one. Projecting nothing is cheap, so this stays correct
		// rather than reaching for a shared sentinel.
		expect(controller.projectTaskHistoryCached(undefined)).toEqual([])
	})

	it("reuses the projection for a stable empty history array", () => {
		const controller = createController()
		const empty: HistoryItem[] = []

		const first = controller.projectTaskHistoryCached(empty)
		const second = controller.projectTaskHistoryCached(empty)

		expect(first).toEqual([])
		expect(second).toBe(first)
	})

	it("drops entries without a timestamp or task text", () => {
		const controller = createController()

		const projected = controller.projectTaskHistoryCached([
			createItem("kept", 2_000),
			{ ...createItem("no-text", 1_000), task: "" } as HistoryItem,
			{ ...createItem("no-ts", 0), ts: 0 } as HistoryItem,
		])

		expect(projected.map((entry) => entry.id)).toEqual(["kept"])
	})
})
