import { describe, expect, it } from "vitest"
import { LANE_BROWSER_SESSION, LANE_DIFF_EDITOR, type ToolLane } from "../../../kernel/turn/tool-lanes"
import { type PooledBlockState, TurnExecutionPool } from "../TurnExecutionPool"

/** A promise whose settlement the test controls. */
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

/** Let queued microtasks run so the pool can settle its scheduling. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve()
	}
}

interface TrackedBlock {
	dlineTid: string
	index: number
	lanes: ToolLane[]
	isTurnEnding: boolean
	run(signal: AbortSignal): Promise<string>
	started: boolean
	aborted: boolean
	settle(value: string): void
	fail(error: unknown): void
}

function trackedBlock(dlineTid: string, index: number, lanes: ToolLane[] = [], isTurnEnding = false): TrackedBlock {
	const gate = deferred<string>()
	const block: TrackedBlock = {
		dlineTid,
		index,
		lanes,
		isTurnEnding,
		started: false,
		aborted: false,
		run: (signal: AbortSignal) => {
			block.started = true
			signal.addEventListener("abort", () => {
				block.aborted = true
			})
			return gate.promise
		},
		settle: gate.resolve,
		fail: gate.reject,
	}
	return block
}

describe("TurnExecutionPool concurrency", () => {
	it("runs up to the limit and starts queued work only as slots free", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 2 })
		const blocks = [trackedBlock("a", 0), trackedBlock("b", 1), trackedBlock("c", 2)]
		const results = blocks.map((block) => pool.submit(block))

		await flush()
		expect(blocks.map((b) => b.started)).toEqual([true, true, false])
		expect(pool.queuedCount).toBe(1)

		blocks[0].settle("a-done")
		await flush()

		// The third block starts because a slot freed, not because the limit
		// changed, so waiting work is never dropped.
		expect(blocks[2].started).toBe(true)

		blocks[1].settle("b-done")
		blocks[2].settle("c-done")
		const outcomes = await Promise.all(results)
		expect(outcomes.map((outcome) => outcome.value)).toEqual(["a-done", "b-done", "c-done"])
	})

	it("reports work beyond the limit as queued rather than leaving it unexplained", async () => {
		const states: Array<[string, PooledBlockState]> = []
		const pool = new TurnExecutionPool<string>({
			limit: 1,
			onStateChange: (dlineTid, state) => states.push([dlineTid, state]),
		})
		const first = trackedBlock("a", 0)
		const second = trackedBlock("b", 1)
		void pool.submit(first)
		const secondResult = pool.submit(second)

		await flush()
		expect(states).toContainEqual(["b", { status: "queued", reason: "limit_reached" }])

		first.settle("a-done")
		second.settle("b-done")
		await secondResult
		expect(states).toContainEqual(["b", { status: "running" }])
	})

	it("re-admits queued work when the limit is raised mid-turn", async () => {
		let limit = 1
		const pool = new TurnExecutionPool<string>({ limit: () => limit })
		const first = trackedBlock("a", 0)
		const second = trackedBlock("b", 1)
		void pool.submit(first)
		void pool.submit(second)

		await flush()
		expect(second.started).toBe(false)

		limit = 2
		pool.notifyLimitChanged()
		await flush()

		// Raising the limit applies to the next admission decision, so the
		// running block does not have to finish first.
		expect(second.started).toBe(true)
		expect(first.aborted).toBe(false)
	})
})

describe("TurnExecutionPool lanes", () => {
	it("never overlaps two blocks that need the same lane", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 4 })
		const first = trackedBlock("a", 0, [LANE_DIFF_EDITOR])
		const second = trackedBlock("b", 1, [LANE_DIFF_EDITOR])
		void pool.submit(first)
		void pool.submit(second)

		await flush()
		// Capacity is available; the lane is what holds the second block.
		expect(first.started).toBe(true)
		expect(second.started).toBe(false)

		first.settle("a-done")
		await flush()
		expect(second.started).toBe(true)
	})

	it("lets blocks on unrelated lanes run together", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 4 })
		const write = trackedBlock("a", 0, [LANE_DIFF_EDITOR])
		const browser = trackedBlock("b", 1, [LANE_BROWSER_SESSION])
		void pool.submit(write)
		void pool.submit(browser)

		await flush()
		expect(write.started).toBe(true)
		expect(browser.started).toBe(true)
	})
})

describe("TurnExecutionPool turn barrier", () => {
	it("holds a turn-ending block until the pool drains", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 4 })
		const ordinary = trackedBlock("a", 0)
		const ending = trackedBlock("z", 1, [], true)
		void pool.submit(ordinary)
		void pool.submit(ending)

		await flush()
		expect(ending.started).toBe(false)
		expect(pool.hasDrained()).toBe(false)

		ordinary.settle("a-done")
		await flush()
		expect(ending.started).toBe(true)
	})

	it("permanently skips work submitted after a turn-ending block starts", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 4 })
		const ending = trackedBlock("z", 0, [], true)
		void pool.submit(ending)

		await flush()
		expect(ending.started).toBe(true)

		// The barrier is latched for the turn: settling the ending block must not
		// reopen execution for a later sibling that the model placed after it.
		const late = trackedBlock("a", 1)
		const lateResult = pool.submit(late)

		await flush()
		expect(late.started).toBe(false)
		ending.settle("z-done")
		await flush()

		const outcome = await lateResult
		expect(late.started).toBe(false)
		expect(outcome.cancelled).toBe(false)
		expect(outcome.skipped).toBe(true)
	})

	it("does not let work overtake a waiting turn-ending block and skips it once the barrier starts", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 4 })
		const running = trackedBlock("a", 0)
		const ending = trackedBlock("z", 1, [], true)
		const behind = trackedBlock("b", 2)
		void pool.submit(running)
		void pool.submit(ending)
		const behindResult = pool.submit(behind)

		await flush()
		expect(ending.started).toBe(false)
		expect(behind.started).toBe(false)

		running.settle("a-done")
		await flush()
		expect(ending.started).toBe(true)
		expect((await behindResult).skipped).toBe(true)
		expect(behind.started).toBe(false)
		ending.settle("z-done")
	})

	it("retires queued work after a refused block without disturbing running work", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 1 })
		const refused = trackedBlock("a", 0)
		const queued = trackedBlock("b", 1)
		void pool.submit(refused)
		const queuedResult = pool.submit(queued)

		await flush()
		expect(refused.started).toBe(true)
		expect(queued.started).toBe(false)

		// A refusal stops work that has not begun, and only that work: the block
		// already running owns its own result and must not be retired with it.
		pool.cancelBlocksAfter(0)
		await flush()

		const outcome = await queuedResult
		expect(outcome.cancelled).toBe(true)
		expect(queued.started).toBe(false)
		expect(refused.started).toBe(true)
		refused.settle("a-done")
	})

	it("keeps the barrier closed while work outside the pool is outstanding", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 4 })
		pool.setUnfinishedEarlierWork(true)
		const ending = trackedBlock("z", 0, [], true)
		void pool.submit(ending)

		await flush()
		// Nothing is running in the pool, but a streaming block elsewhere has
		// not finished, so the barrier must not open on the pool's own view.
		expect(ending.started).toBe(false)

		// Clearing the flag must admit the block by itself. Needing an
		// unrelated event to nudge the pool would leave the turn stalled
		// whenever no such event happens to arrive.
		pool.setUnfinishedEarlierWork(false)
		await flush()
		expect(ending.started).toBe(true)
	})
})

describe("TurnExecutionPool cancellation", () => {
	it("settles a queued block as cancelled without ever starting it", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 1 })
		const running = trackedBlock("a", 0)
		const queued = trackedBlock("b", 1)
		void pool.submit(running)
		const queuedResult = pool.submit(queued)

		await flush()
		pool.cancel("b")
		const outcome = await queuedResult

		expect(outcome.cancelled).toBe(true)
		expect(queued.started).toBe(false)
		running.settle("a-done")
	})

	it("aborts a running block and reports it as cancelled rather than settled", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 2 })
		const block = trackedBlock("a", 0)
		const result = pool.submit(block)

		await flush()
		pool.cancel("a")
		expect(block.aborted).toBe(true)

		// The effect resolves after the abort; the outcome must still say
		// cancelled, or a restart would project finished work that never was.
		block.settle("ignored")
		const outcome = await result
		expect(outcome.cancelled).toBe(true)
		expect(outcome.value).toBeUndefined()
	})

	it("settles a cancelled block whose effect ignores the abort signal", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 2 })
		// This block never settles and never reacts to its signal. A pool that
		// waited for the effect would owe the turn a result it can never get, so
		// cancellation has to be the pool's own decision rather than a request
		// the tool is free to ignore.
		const stubborn = trackedBlock("a", 0)
		const result = pool.submit(stubborn)

		await flush()
		pool.cancel("a")

		const outcome = await result
		expect(outcome.cancelled).toBe(true)
		expect(outcome.dlineTid).toBe("a")
		expect(pool.orderedOutcomes()).toHaveLength(1)
	})

	it("cancels every block when the turn is cancelled", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 1 })
		const first = trackedBlock("a", 0)
		const second = trackedBlock("b", 1)
		const results = Promise.all([pool.submit(first), pool.submit(second)])

		await flush()
		pool.cancelAll()
		first.settle("ignored")

		const outcomes = await results
		expect(outcomes.every((outcome) => outcome.cancelled)).toBe(true)
		expect(first.aborted).toBe(true)
	})
})

describe("TurnExecutionPool results", () => {
	it("assembles outcomes in assistant order regardless of completion order", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 3 })
		const first = trackedBlock("a", 0)
		const second = trackedBlock("b", 1)
		const third = trackedBlock("c", 2)
		const results = Promise.all([pool.submit(first), pool.submit(second), pool.submit(third)])

		await flush()
		third.settle("c-done")
		second.settle("b-done")
		first.settle("a-done")
		await results

		expect(pool.orderedOutcomes().map((outcome) => outcome.dlineTid)).toEqual(["a", "b", "c"])
	})

	it("reports a throwing block as an error outcome instead of abandoning the turn", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 2 })
		const failing = trackedBlock("a", 0)
		const healthy = trackedBlock("b", 1)
		const results = Promise.all([pool.submit(failing), pool.submit(healthy)])

		await flush()
		const boom = new Error("tool failed")
		failing.fail(boom)
		healthy.settle("b-done")

		const [failingOutcome, healthyOutcome] = await results
		// The failure is reported as this block's outcome, so the remaining
		// calls still get results instead of the turn unwinding.
		expect(failingOutcome.error).toBe(boom)
		expect(failingOutcome.value).toBeUndefined()
		expect(failingOutcome.cancelled).toBe(false)
		expect(healthyOutcome.value).toBe("b-done")
	})

	it("records one outcome per block even when cancellation races the runner", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 1 })
		const running = trackedBlock("a", 0)
		const queued = trackedBlock("b", 1)
		const results = Promise.all([pool.submit(running), pool.submit(queued)])

		await flush()
		// Cancel the queued block and free the slot in the same tick, so the
		// canceller and the scheduler both reach for it.
		pool.cancel("b")
		running.settle("a-done")
		await results

		const outcomes = pool.orderedOutcomes()
		expect(outcomes.map((outcome) => outcome.dlineTid)).toEqual(["a", "b"])
	})
})
