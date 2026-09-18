import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import { SubagentFanoutBudget, type SubagentSlot } from "../SubagentFanoutBudget"
import { SubagentRunner } from "../SubagentRunner"

/**
 * A runner interrupted while a tool is still executing resolves early: the run
 * reports `cancelled` but the abandoned tool keeps holding a terminal, a file
 * handle or a host request.
 *
 * `runBudgetedSubagent` therefore waits on the runner's abandoned work before
 * returning the slot. These tests pin that ordering against the budget, using a
 * stand-in for the runner so the accounting rule is tested rather than the
 * runner's internals.
 */
describe("SubagentFanoutBudget interrupt accounting", () => {
	/** Deterministically drain the microtask queue. */
	async function flush(): Promise<void> {
		for (let index = 0; index < 8; index++) await Promise.resolve()
	}

	interface FakeRunner {
		whenAbandonedWorkSettled(timeoutMs?: number): Promise<boolean | void>
	}

	/** A runner whose abandoned tool settles only when the test releases it. */
	function runnerWithPendingAbandonedWork(): { runner: FakeRunner; settle: () => void } {
		let settle: (() => void) | undefined
		const pending = new Promise<void>((resolve) => {
			settle = resolve
		})
		return {
			runner: { whenAbandonedWorkSettled: () => pending },
			settle: () => settle?.(),
		}
	}

	/**
	 * Mirror the handler's release ordering: the run resolves, then the slot is
	 * returned only after the runner's abandoned work has settled.
	 */
	async function runThenRelease(budget: SubagentFanoutBudget, runner: FakeRunner): Promise<void> {
		const admission = await budget.acquire()
		assert.equal(admission.admitted, true)
		const slot = (admission as { slot: SubagentSlot }).slot
		try {
			// The run itself resolves immediately, as an interrupted run does.
		} finally {
			await runner.whenAbandonedWorkSettled()
			slot.release()
		}
	}

	it("does not admit replacement work while an abandoned tool is still running", async () => {
		const budget = new SubagentFanoutBudget({ limit: 1 })
		const { runner, settle } = runnerWithPendingAbandonedWork()

		const interrupted = runThenRelease(budget, runner)
		await flush()

		let replacementStarted = false
		const replacement = budget.acquire().then((admission) => {
			replacementStarted = admission.admitted
		})
		await flush()

		assert.equal(replacementStarted, false, "the slot must stay held while the abandoned tool runs")
		assert.equal(budget.state().running, 1)

		settle()
		await interrupted
		await replacement
		assert.equal(replacementStarted, true, "the slot must be reusable once the abandoned tool has stopped")
	})

	it("releases immediately when the run abandoned nothing", async () => {
		const budget = new SubagentFanoutBudget({ limit: 1 })
		const clean: FakeRunner = { whenAbandonedWorkSettled: async () => undefined }

		await runThenRelease(budget, clean)

		assert.equal(budget.state().running, 0, "the normal path must not hold the slot")
		const admission = await budget.acquire()
		assert.equal(admission.admitted, true)
	})

	it("reclaims the slot when an abandoned tool never settles, so the batch still finishes", async () => {
		const budget = new SubagentFanoutBudget({ limit: 1 })
		// A wedged tool: it never settles, so an unbounded wait would strand
		// every queued item behind this one slot.
		const wedged: FakeRunner = { whenAbandonedWorkSettled: async () => false }

		await runThenRelease(budget, wedged)

		assert.equal(budget.state().running, 0, "a deadline must return the slot even when the tool is stuck")
		const replacement = await budget.acquire()
		assert.equal(replacement.admitted, true, "the remaining batch items must still be admitted")
	})
})

/**
 * The deadline itself belongs to the runner, so it is proven against the real
 * implementation rather than the stand-in above.
 */
describe("SubagentRunner abandoned work deadline", () => {
	it("reports failure to settle instead of waiting forever", async () => {
		const runner = Object.create(SubagentRunner.prototype) as {
			abandonedToolExecutions: Set<Promise<unknown>>
			whenAbandonedWorkSettled(timeoutMs?: number): Promise<boolean>
		}
		// A tool that never resolves stands in for a wedged host request.
		Object.defineProperty(runner, "abandonedToolExecutions", {
			value: new Set<Promise<unknown>>([new Promise<void>(() => undefined)]),
			writable: true,
		})

		const settled = await runner.whenAbandonedWorkSettled(10)

		assert.equal(settled, false, "the wait must expire rather than block the caller forever")
	})

	it("reports success once the abandoned tool has stopped", async () => {
		const runner = Object.create(SubagentRunner.prototype) as {
			abandonedToolExecutions: Set<Promise<unknown>>
			whenAbandonedWorkSettled(timeoutMs?: number): Promise<boolean>
		}
		Object.defineProperty(runner, "abandonedToolExecutions", {
			value: new Set<Promise<unknown>>(),
			writable: true,
		})

		const settled = await runner.whenAbandonedWorkSettled(10)

		assert.equal(settled, true)
	})

	it("charges one wedged tool once, even when a retry reuses the same runner", async () => {
		// A runner outlives its attempts. If every attempt re-claimed the same
		// wedged tool, a single stuck tool would keep shrinking the allowance
		// until unrelated items could never be admitted.
		const runner = Object.create(SubagentRunner.prototype) as {
			abandonedToolExecutions: Set<Promise<unknown>>
			claimedAbandonedWork: Set<Promise<unknown>>
			claimOutstandingAbandonedWork(): Promise<unknown> | undefined
		}
		const wedged = new Promise<void>(() => undefined)
		Object.defineProperty(runner, "abandonedToolExecutions", {
			value: new Set<Promise<unknown>>([wedged]),
			writable: true,
		})
		Object.defineProperty(runner, "claimedAbandonedWork", {
			value: new Set<Promise<unknown>>(),
			writable: true,
		})

		const firstAttempt = runner.claimOutstandingAbandonedWork()
		const retryAttempt = runner.claimOutstandingAbandonedWork()

		assert.notEqual(firstAttempt, undefined, "the attempt that gave up must charge the wedged tool")
		assert.equal(retryAttempt, undefined, "a retry must not charge the same wedged tool again")
	})

	it("keeps the effective limit at one when a retry re-runs behind one wedged tool", async () => {
		/** Deterministically drain the microtask queue. */
		const drain = async (): Promise<void> => {
			for (let index = 0; index < 8; index++) await Promise.resolve()
		}
		const budget = new SubagentFanoutBudget({ limit: 2 })
		const runner = Object.create(SubagentRunner.prototype) as {
			abandonedToolExecutions: Set<Promise<unknown>>
			claimedAbandonedWork: Set<Promise<unknown>>
			claimOutstandingAbandonedWork(): Promise<unknown> | undefined
		}
		Object.defineProperty(runner, "abandonedToolExecutions", {
			value: new Set<Promise<unknown>>([new Promise<void>(() => undefined)]),
			writable: true,
		})
		Object.defineProperty(runner, "claimedAbandonedWork", {
			value: new Set<Promise<unknown>>(),
			writable: true,
		})

		// Two attempts on the same runner both give up waiting for the tool.
		for (let attempt = 0; attempt < 2; attempt++) {
			const outstanding = runner.claimOutstandingAbandonedWork()
			if (outstanding) budget.withholdCapacity(outstanding)
		}
		await drain()

		const first = await budget.acquire()
		assert.equal(first.admitted, true, "one wedged tool must leave one usable slot")

		let secondAdmitted = false
		const second = budget.acquire().then((admission) => {
			secondAdmitted = admission.admitted
		})
		await drain()
		assert.equal(secondAdmitted, false, "the wedged tool still holds exactly one unit of the allowance")

		;(first as { slot: SubagentSlot }).slot.release()
		await second
		assert.equal(secondAdmitted, true, "returning the real slot must admit the queued item")
	})
})
