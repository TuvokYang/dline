import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import { SubagentFanoutBudget, type SubagentSlot } from "../SubagentFanoutBudget"

/** A deferred whose resolution the test controls. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

/** Let queued microtasks settle so admissions become observable. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve()
	}
}

interface FanoutItem {
	/** Resolved once this item has been admitted and begun running. */
	started: boolean
	/** Settle the item's work. */
	finish: () => void
	/** Terminal result, once the item has completed. */
	result: Promise<string>
}

/**
 * Run `count` items against the budget the way the batch handler does.
 *
 * The slot is taken before the work starts and released only after it has
 * stopped, which is what the handler's `runBudgetedSubagent` guarantees.
 */
function fanOut(budget: SubagentFanoutBudget, count: number): { items: FanoutItem[]; all: Promise<string[]> } {
	const items: FanoutItem[] = []
	const runs: Array<Promise<string>> = []

	for (let index = 0; index < count; index++) {
		const gate = deferred<void>()
		const item: FanoutItem = {
			started: false,
			finish: () => gate.resolve(),
			result: Promise.resolve(""),
		}
		const run = (async () => {
			const admission = await budget.acquire()
			assert.equal(admission.admitted, true)
			if (!admission.admitted) throw new Error("unreachable")
			const slot: SubagentSlot = admission.slot
			item.started = true
			try {
				await gate.promise
				return `item ${index + 1}`
			} finally {
				slot.release()
			}
		})()
		item.result = run
		items.push(item)
		runs.push(run)
	}

	return { items, all: Promise.all(runs) }
}

/** Count how many items have begun running. */
function startedCount(items: readonly FanoutItem[]): number {
	return items.filter((item) => item.started).length
}

describe("subagent fan-out under a bounded budget", () => {
	it("starts only up to the limit and still completes every item", async () => {
		const budget = new SubagentFanoutBudget({ limit: 2 })
		const { items, all } = fanOut(budget, 5)

		await flush()
		assert.equal(startedCount(items), 2, "a batch wider than the limit must not start every item at once")
		assert.equal(budget.state().queued, 3, "the remainder is queued, not dropped")

		// Draining one item admits exactly one more, never a burst.
		items[0].finish()
		await flush()
		assert.equal(startedCount(items), 3)

		for (const item of items) {
			item.finish()
		}

		const results = await all
		assert.deepEqual(results, ["item 1", "item 2", "item 3", "item 4", "item 5"])
		assert.equal(budget.state().running, 0)
		assert.equal(budget.state().queued, 0)
	})

	it("does not start a queued item before capacity is actually freed", async () => {
		const budget = new SubagentFanoutBudget({ limit: 1 })
		const { items, all } = fanOut(budget, 3)

		await flush()
		assert.equal(startedCount(items), 1)

		// Nothing has been released, so repeated scheduling opportunities must
		// not admit work the budget cannot pay for.
		await flush()
		await flush()
		assert.equal(startedCount(items), 1)

		for (const item of items) {
			item.finish()
		}
		await all
		assert.equal(startedCount(items), 3)
	})

	it("widens fan-out immediately when the limit is raised mid-batch", async () => {
		let limit = 1
		const budget = new SubagentFanoutBudget({ limit: () => limit })
		const { items, all } = fanOut(budget, 4)

		await flush()
		assert.equal(startedCount(items), 1)

		limit = 3
		budget.notifyLimitChanged()
		await flush()
		assert.equal(startedCount(items), 3, "raising the setting must reach already-queued items")

		for (const item of items) {
			item.finish()
		}
		await all
	})

	it("keeps two tasks' budgets independent", async () => {
		const first = new SubagentFanoutBudget({ limit: 1 })
		const second = new SubagentFanoutBudget({ limit: 1 })

		const firstRun = fanOut(first, 2)
		const secondRun = fanOut(second, 2)
		await flush()

		// One saturated task must not throttle another; the budget is scoped to
		// a task, not shared process-wide.
		assert.equal(startedCount(firstRun.items), 1)
		assert.equal(startedCount(secondRun.items), 1)

		for (const item of [...firstRun.items, ...secondRun.items]) {
			item.finish()
		}
		await Promise.all([firstRun.all, secondRun.all])
	})
})
