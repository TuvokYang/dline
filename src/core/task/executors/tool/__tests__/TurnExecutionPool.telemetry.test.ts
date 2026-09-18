import { beforeEach, describe, expect, it, vi } from "vitest"

const capturePoolAdmission = vi.fn()
const recordPoolOccupancy = vi.fn()
const forgetPoolInstance = vi.fn()

// Replaced at the module boundary rather than injected: the pool reaches the
// telemetry singleton directly, which is the established pattern for handlers
// in this domain, and the point of these tests is what that real call site
// reports.
vi.mock("@/services/telemetry", () => ({
	telemetryService: {
		capturePoolAdmission: (...args: unknown[]) => capturePoolAdmission(...args),
		recordPoolOccupancy: (...args: unknown[]) => recordPoolOccupancy(...args),
		forgetPoolInstance: (...args: unknown[]) => forgetPoolInstance(...args),
	},
}))

const { TurnExecutionPool } = await import("../TurnExecutionPool")

/** A promise whose settlement the test controls. */
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

/** Let queued microtasks run so the pool can settle its scheduling. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve()
	}
}

function blockingBlock(dlineTid: string, index: number) {
	const gate = deferred<string>()
	return {
		dlineTid,
		index,
		lanes: [],
		isTurnEnding: false,
		run: () => gate.promise,
		settle: gate.resolve,
	}
}

describe("TurnExecutionPool queue wait telemetry", () => {
	beforeEach(() => {
		capturePoolAdmission.mockClear()
		recordPoolOccupancy.mockClear()
	})

	it("measures the wait from submission, not from the moment admission was granted", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 1 })
		const first = blockingBlock("a", 0)
		const second = blockingBlock("b", 1)

		const firstOutcome = pool.submit(first)
		const secondOutcome = pool.submit(second)
		await flush()

		// The second block is queued behind the first. Advancing the clock here
		// is what separates a wait measured from submission from one measured
		// inside `start()`: admission is decided in `schedule()`, so by the time
		// `start()` runs for the second block its permit is already available
		// and a timer opened there would report ~0 no matter how long the block
		// had been waiting.
		const realNow = Date.now
		const submittedAt = realNow()
		vi.spyOn(Date, "now").mockImplementation(() => submittedAt + 5_000)

		first.settle("done")
		await firstOutcome
		await flush()

		second.settle("done")
		await secondOutcome
		await flush()
		vi.mocked(Date.now).mockRestore()

		const waits = capturePoolAdmission.mock.calls.map((call) => (call[0] as { queueWaitMs: number }).queueWaitMs)
		expect(waits).toHaveLength(2)
		// The first block was admitted immediately; the second waited for the
		// first to finish and must carry that wait.
		expect(waits[1]).toBeGreaterThanOrEqual(5_000)
	})

	it("labels both samples as the tool pool and reports the configured limit", async () => {
		const pool = new TurnExecutionPool<string>({ limit: 3 })
		const block = blockingBlock("a", 0)

		const outcome = pool.submit(block)
		await flush()
		block.settle("done")
		await outcome
		await flush()

		const admission = capturePoolAdmission.mock.calls[0]?.[0] as { pool: string; limit: number }
		expect(admission.pool).toBe("tool")
		expect(admission.limit).toBe(3)

		// Release must re-sample, or the gauges keep the admission values and
		// the pool reads as permanently occupied.
		const release = recordPoolOccupancy.mock.calls.at(-1)?.[0] as { pool: string; running: number }
		expect(release.pool).toBe("tool")
		expect(release.running).toBe(0)
	})
})
