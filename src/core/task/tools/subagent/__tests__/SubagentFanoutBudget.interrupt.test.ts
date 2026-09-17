import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import { SubagentFanoutBudget, type SubagentSlot } from "../SubagentFanoutBudget"

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
		whenAbandonedWorkSettled(): Promise<void>
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
})
