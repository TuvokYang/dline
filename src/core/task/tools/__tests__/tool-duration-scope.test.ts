import { describe, expect, it } from "vitest"
import { ToolDurationScope } from "../tool-duration-scope"

/**
 * Behavior guard for separating a tool's own work from time it merely waited.
 *
 * A threshold on wall-clock tool duration would fire on a slow reviewer or a
 * long-running build rather than on slow code, so the active duration must
 * exclude approval and command waits — including when those waits overlap or
 * end abnormally.
 */

/** Deterministic clock so durations are asserted, not timed. */
function createClock() {
	let now = 0
	return {
		read: () => now,
		advance: (ms: number) => {
			now += ms
		},
	}
}

describe("ToolDurationScope", () => {
	it("reports all elapsed time as active when nothing waited", () => {
		const clock = createClock()
		const scope = new ToolDurationScope(clock.read)

		clock.advance(40)

		expect(scope.read()).toEqual({
			elapsedMs: 40,
			activeMs: 40,
			approvalWaitMs: 0,
			commandWaitMs: 0,
		})
	})

	it("excludes approval and command waits from the active duration", async () => {
		const clock = createClock()
		const scope = new ToolDurationScope(clock.read)

		clock.advance(5)
		await scope.excludeWait("approval", async () => {
			clock.advance(1_000)
		})
		clock.advance(10)
		await scope.excludeWait("command", async () => {
			clock.advance(30_000)
		})
		clock.advance(5)

		const totals = scope.read()
		expect(totals.elapsedMs).toBe(31_020)
		// Only the work between the waits is attributed to the tool.
		expect(totals.activeMs).toBe(20)
		expect(totals.approvalWaitMs).toBe(1_000)
		expect(totals.commandWaitMs).toBe(30_000)
	})

	it("counts an overlapping approval inside a command exactly once per kind", async () => {
		const clock = createClock()
		const scope = new ToolDurationScope(clock.read)

		await scope.excludeWait("command", async () => {
			clock.advance(100)
			// A command that prompts mid-run nests one wait inside another. Both
			// kinds are reported, but the shared period must not be subtracted
			// twice, which would drive the active duration negative.
			await scope.excludeWait("approval", async () => {
				clock.advance(500)
			})
			clock.advance(100)
		})

		const totals = scope.read()
		expect(totals.elapsedMs).toBe(700)
		expect(totals.commandWaitMs).toBe(700)
		expect(totals.approvalWaitMs).toBe(500)
		expect(totals.activeMs).toBe(0)
	})

	it("counts an overlapping period once when work follows it", async () => {
		const clock = createClock()
		const scope = new ToolDurationScope(clock.read)

		await scope.excludeWait("command", async () => {
			clock.advance(100)
			await scope.excludeWait("approval", async () => {
				clock.advance(500)
			})
			clock.advance(100)
		})
		clock.advance(300)

		const totals = scope.read()
		// Subtracting each kind separately would remove the shared 500 ms twice
		// and report the trailing work as zero.
		expect(totals.elapsedMs).toBe(1_000)
		expect(totals.activeMs).toBe(300)
	})

	it("closes a wait whose operation throws", async () => {
		const clock = createClock()
		const scope = new ToolDurationScope(clock.read)

		await expect(
			scope.excludeWait("command", async () => {
				clock.advance(900)
				throw new Error("command failed")
			}),
		).rejects.toThrow("command failed")
		clock.advance(30)

		const totals = scope.read()
		// A failed command is still time the tool spent waiting, and the work
		// after it must still be measured.
		expect(totals.commandWaitMs).toBe(900)
		expect(totals.activeMs).toBe(30)
	})

	it("counts a wait that never closed rather than reporting it as active work", () => {
		const clock = createClock()
		const scope = new ToolDurationScope(clock.read)

		// Reading while an approval is still open is what a cancellation path
		// does; the pending wait must not be attributed to the tool.
		void scope.excludeWait("approval", () => new Promise<void>(() => {}))
		clock.advance(2_000)

		const totals = scope.read()
		expect(totals.approvalWaitMs).toBe(2_000)
		expect(totals.activeMs).toBe(0)
	})

	it("keeps nested waits of the same kind from double counting", async () => {
		const clock = createClock()
		const scope = new ToolDurationScope(clock.read)

		await scope.excludeWait("approval", async () => {
			clock.advance(200)
			await scope.excludeWait("approval", async () => {
				clock.advance(300)
			})
			clock.advance(200)
		})

		const totals = scope.read()
		expect(totals.approvalWaitMs).toBe(700)
		expect(totals.activeMs).toBe(0)
	})
})
