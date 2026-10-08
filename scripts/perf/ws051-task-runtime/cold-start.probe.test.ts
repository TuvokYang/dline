import { expect, it } from "vitest"

it("imports the public Task entry in a fresh worker", async () => {
	const started = process.hrtime.bigint()
	const entry = await import("@perf/task-entry")
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000

	expect(typeof entry.Task).toBe("function")
	console.log(
		`WS051_SAMPLE ${JSON.stringify({
			metric: "cold_start",
			variant: process.env.WS051_VARIANT,
			pid: process.pid,
			runId: process.env.WS051_RUN_ID,
			elapsedMs,
		})}`,
	)
})
