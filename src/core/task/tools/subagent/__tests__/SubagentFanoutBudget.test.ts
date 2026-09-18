import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import { MAX_SUBAGENT_NESTING_DEPTH, SubagentFanoutBudget, type SubagentSlot, usableSubagentLimit } from "../SubagentFanoutBudget"

/** Let queued microtasks settle so admissions become observable. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve()
	}
}

/** Acquire and assert admission, returning the slot. */
async function take(budget: SubagentFanoutBudget): Promise<SubagentSlot> {
	const admission = await budget.acquire()
	assert.equal(admission.admitted, true)
	if (!admission.admitted) throw new Error("unreachable")
	return admission.slot
}

describe("SubagentFanoutBudget", () => {
	describe("width", () => {
		it("admits up to the limit and queues the remainder", async () => {
			const budget = new SubagentFanoutBudget({ limit: 2 })

			const first = await take(budget)
			await take(budget)

			let thirdAdmitted = false
			const third = budget.acquire().then((admission) => {
				thirdAdmitted = admission.admitted
				return admission
			})

			await flush()
			assert.equal(thirdAdmitted, false)
			assert.deepEqual(budget.state(), { running: 2, queued: 1, limit: 2, depth: 0 })

			first.release()
			await third
			assert.equal(thirdAdmitted, true)
			assert.equal(budget.state().running, 2)
			assert.equal(budget.state().queued, 0)
		})

		it("ignores a repeated release so capacity is not double counted", async () => {
			const budget = new SubagentFanoutBudget({ limit: 1 })
			const slot = await take(budget)

			slot.release()
			slot.release()

			assert.equal(budget.state().running, 0)
		})

		it("reads the limit at admission time so a raised setting takes effect", async () => {
			let limit = 1
			const budget = new SubagentFanoutBudget({ limit: () => limit })
			await take(budget)

			let secondAdmitted = false
			const second = budget.acquire().then((admission) => {
				secondAdmitted = admission.admitted
				return admission
			})
			await flush()
			assert.equal(secondAdmitted, false)

			limit = 2
			budget.notifyLimitChanged()
			await second
			assert.equal(secondAdmitted, true)
		})
	})

	describe("nesting", () => {
		it("shares one allowance across depths rather than multiplying it", async () => {
			const budget = new SubagentFanoutBudget({ limit: 2 })
			const parentSlot = await take(budget)
			const child = budget.child(parentSlot)

			await take(child)

			let grandchildAdmitted = false
			const queued = child.acquire().then((admission) => {
				grandchildAdmitted = admission.admitted
				return admission
			})
			await flush()

			// The parent's own slot plus one child fills a limit of two; a
			// second child waits instead of receiving a fresh allowance.
			assert.equal(grandchildAdmitted, false)
			assert.equal(child.state().running, 2)

			parentSlot.release()
			await queued
			assert.equal(grandchildAdmitted, true)
		})

		it("refuses a fan-out deeper than the declared ceiling without queueing", async () => {
			const budget = new SubagentFanoutBudget({ limit: 8, maxDepth: 2 })
			const level1 = budget.child()
			const level2 = level1.child()

			assert.equal(budget.canNest(), true)
			assert.equal(level1.canNest(), true)
			assert.equal(level2.canNest(), false)

			const refused = await level2.acquire()
			assert.equal(refused.admitted, false)
			if (refused.admitted) throw new Error("unreachable")
			assert.equal(refused.reason, "depth_exceeded")
			assert.match(refused.message, /nesting depth limit reached \(2\)/)
			// A refusal must not consume or reserve capacity.
			assert.equal(budget.state().running, 0)
			assert.equal(budget.state().queued, 0)
		})

		it("defaults the ceiling to the declared maximum depth", () => {
			const budget = new SubagentFanoutBudget({ limit: 4 })
			let view = budget
			for (let depth = 0; depth < MAX_SUBAGENT_NESTING_DEPTH; depth++) {
				assert.equal(view.canNest(), true, `depth ${depth} should still nest`)
				view = view.child()
			}
			assert.equal(view.canNest(), false)
		})

		it("frees the parent slot while it waits on its children", async () => {
			const budget = new SubagentFanoutBudget({ limit: 1 })
			const parentSlot = await take(budget)
			const child = budget.child(parentSlot)

			// Without surrendering the parent slot this await could never be
			// satisfied: the only slot is held by the caller waiting for it.
			const result = await child.awaitChildren(async () => {
				const childSlot = await take(child)
				childSlot.release()
				return "done"
			})

			assert.equal(result, "done")
			assert.equal(budget.state().running, 0)
		})

		it("keeps the task's own fan-out a plain await when nothing owns a slot", async () => {
			const budget = new SubagentFanoutBudget({ limit: 1 })

			const result = await budget.awaitChildren(async () => {
				const slot = await take(budget)
				slot.release()
				return 42
			})

			assert.equal(result, 42)
			assert.equal(budget.state().running, 0)
		})
	})

	describe("interrupt accounting", () => {
		it("keeps the slot held until the abandoned work reports it stopped", async () => {
			const budget = new SubagentFanoutBudget({ limit: 1 })
			const slot = await take(budget)

			// The runner has returned but its abandoned tool is still executing;
			// the caller has not released, so replacement work must not start.
			let replacementAdmitted = false
			const replacement = budget.acquire().then((admission) => {
				replacementAdmitted = admission.admitted
				return admission
			})
			await flush()
			assert.equal(replacementAdmitted, false)
			assert.equal(budget.state().running, 1)

			slot.release()
			await replacement
			assert.equal(replacementAdmitted, true)
		})
	})

	describe("usableSubagentLimit", () => {
		it("never returns a limit below one", () => {
			assert.equal(usableSubagentLimit(0), 1)
			assert.equal(usableSubagentLimit(-4), 1)
			assert.equal(usableSubagentLimit(Number.NaN), 1)
			assert.equal(usableSubagentLimit(Number.POSITIVE_INFINITY), 1)
		})

		it("truncates a fractional configured value", () => {
			assert.equal(usableSubagentLimit(3.9), 3)
			assert.equal(usableSubagentLimit(64), 64)
		})
	})
})
