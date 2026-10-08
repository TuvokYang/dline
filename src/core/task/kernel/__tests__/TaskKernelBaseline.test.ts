import { performance } from "node:perf_hooks"
import { describe, expect, it } from "vitest"
import { createInitialTaskState, type TaskEvent, transition } from ".."

const CORPUS: readonly TaskEvent[] = Array.from({ length: 250 }, (_, index) => ({
	type: "background.ready" as const,
	generation: 0,
	entryId: `entry-${index}`,
	payloadRef: `payload-${index}`,
}))

function sample(): number {
	let state = createInitialTaskState("benchmark")
	const started = performance.now()
	for (const event of CORPUS) {
		const result = transition(state, event)
		if (result.kind === "accepted") state = result.state
	}
	return ((performance.now() - started) * 1_000) / CORPUS.length
}

describe("task kernel performance baseline", () => {
	it("records a bounded microsecond-per-transition baseline", () => {
		for (let index = 0; index < 5; index++) sample()
		const samples = Array.from({ length: 20 }, sample).sort((a, b) => a - b)
		const median = samples[Math.floor(samples.length / 2)]
		const p95 = samples[Math.floor(samples.length * 0.95) - 1]
		console.info(
			"TASK-101 performance baseline",
			JSON.stringify({ unit: "microseconds_per_transition", samples, median, p95 }),
		)
		expect({ samples, median, p95 }).toMatchObject({ median: expect.any(Number), p95: expect.any(Number) })
		expect(p95).toBeLessThan(5_000)
	})
})
