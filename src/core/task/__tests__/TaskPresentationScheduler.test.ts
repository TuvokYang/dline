import { describe, it, vi } from "vitest"
import "should"
// sinon import removed: using vitest globals

import { TaskPresentationScheduler } from "../TaskPresentationScheduler"

describe("TaskPresentationScheduler", () => {
	it("rethrows flush errors from flushNow so callers do not hang on hidden failures", async () => {
		const scheduler = new TaskPresentationScheduler({
			flush: async () => {
				throw new Error("flush failed")
			},
			getDelayMs: () => 10,
		})

		await scheduler
			.flushNow()
			.then(() => {
				throw new Error("expected flushNow to reject")
			})
			.catch((error: Error) => {
				error.message.should.equal("flush failed")
			})
	})

	it("coalesces multiple normal-priority requests into a single timer", () => {
		const clock = vi.useFakeTimers()
		const flushSpy = vi.fn(async () => {})

		const scheduler = new TaskPresentationScheduler({
			flush: flushSpy,
			getDelayMs: () => 50,
		})

		scheduler.requestFlush("normal")
		scheduler.requestFlush("normal")
		scheduler.requestFlush("normal")

		clock.advanceTimersByTime(49)
		flushSpy.mock.calls.length.should.equal(0)

		clock.advanceTimersByTime(1)
		flushSpy.mock.calls.length.should.equal(1)

		clock.useRealTimers()
	})

	it("waits for an in-flight flush and runs the requested immediate flush before resolving flushNow", async () => {
		let resolveFirstFlush: (() => void) | undefined
		let flushCount = 0

		const scheduler = new TaskPresentationScheduler({
			flush: async () => {
				flushCount += 1
				if (flushCount === 1) {
					await new Promise<void>((resolve) => {
						resolveFirstFlush = resolve
					})
				}
			},
			getDelayMs: () => 0,
		})

		scheduler.requestFlush("immediate")
		await Promise.resolve()

		let didResolve = false
		const flushNowPromise = scheduler.flushNow().then(() => {
			didResolve = true
		})

		await Promise.resolve()
		flushCount.should.equal(1)
		didResolve.should.equal(false)

		resolveFirstFlush?.()
		await flushNowPromise

		flushCount.should.equal(2)
		didResolve.should.equal(true)
	})

	it("does not rethrow errors from an overlapping in-flight flush when flushNow is called", async () => {
		let rejectFirstFlush: ((error: Error) => void) | undefined
		let flushCount = 0

		const scheduler = new TaskPresentationScheduler({
			flush: async () => {
				flushCount += 1
				if (flushCount === 1) {
					await new Promise<void>((_, reject) => {
						rejectFirstFlush = reject
					})
				}
			},
			getDelayMs: () => 0,
		})

		scheduler.requestFlush("immediate")
		await Promise.resolve()

		let flushNowResolved = false
		const flushNowPromise = scheduler.flushNow().then(() => {
			flushNowResolved = true
		})
		rejectFirstFlush?.(new Error("flush failed"))

		await flushNowPromise
		flushNowResolved.should.equal(true)
		flushCount.should.equal(2)
	})

	it("flushNow guarantees a flush even when the post-flush continuation consumed pendingPriority", async () => {
		// Regression test for the race condition where:
		// 1. A timer fires → runFlushCycle starts, sets flushInProgress=true, clears pendingPriority
		// 2. flushNow() is called → sets pendingPriority="immediate", enters runFlushCycle
		// 3. runFlushCycle sees flushInProgress, awaits currentFlushCompletion
		// 4. In-flight flush completes → post-flush continuation sees pendingPriority="immediate",
		//    calls runFlushCycle recursively → clears pendingPriority, runs flush #2
		// 5. flushNow()'s runFlushCycle resumes → pendingPriority is now undefined → would return
		//    without flushing (the bug)
		//
		// The fix: flushNow() waits for all in-flight flushes to drain *before* setting
		// pendingPriority, so the continuation cannot steal it.

		let resolveFirstFlush: (() => void) | undefined
		let flushCount = 0

		const scheduler = new TaskPresentationScheduler({
			flush: async () => {
				flushCount += 1
				if (flushCount === 1) {
					// First flush: pause so flushNow() arrives while it's in-flight
					await new Promise<void>((resolve) => {
						resolveFirstFlush = resolve
					})
				}
			},
			getDelayMs: () => 0,
		})

		// Start the first flush (via immediate requestFlush)
		scheduler.requestFlush("immediate")
		// Yield so the async flush body starts executing
		await Promise.resolve()
		await Promise.resolve()

		// flushNow() is called while flush #1 is paused mid-execution
		let flushNowResolved = false
		const flushNowPromise = scheduler.flushNow().then(() => {
			flushNowResolved = true
		})

		// Unblock flush #1
		resolveFirstFlush?.()
		await flushNowPromise

		// flushNow must have triggered a second flush after flush #1 completed
		flushNowResolved.should.equal(true)
		flushCount.should.equal(2)
	})

	it("keeps the in-flight completion handle when a flush starts while the previous cycle is settling", async () => {
		// A cycle clears `flushInProgress` inside its own completion and only
		// afterwards resumes to release its handle. An immediate request landing
		// between the two starts the next cycle, which must keep its handle:
		// `flushNow()` waits on that handle while a flush is in progress, and
		// waiting on a missing one spins on microtasks without ever letting the
		// pending flush finish. The exact gap depends on microtask ordering, so
		// the request is issued at every depth around it.
		type LaneView = { flushInProgress: boolean; currentFlushCompletion?: Promise<unknown> }
		const orphanedDepths: number[] = []

		for (let depth = 0; depth <= 8; depth += 1) {
			const releases: Array<() => void> = []
			const scheduler = new TaskPresentationScheduler({
				flush: () =>
					new Promise<void>((resolve) => {
						releases.push(resolve)
					}),
				getDelayMs: () => 0,
			})

			scheduler.requestFlush("immediate")
			releases[0]?.()
			let gap = Promise.resolve()
			for (let step = 0; step < depth; step += 1) gap = gap.then(() => undefined)
			void gap.then(() => scheduler.requestFlush("immediate"))
			await new Promise((resolve) => setTimeout(resolve, 0))

			const lane = (scheduler as unknown as { lane: LaneView }).lane
			if (lane.flushInProgress && !lane.currentFlushCompletion) orphanedDepths.push(depth)
			for (const release of releases.slice(1)) release()
			await scheduler.dispose()
		}

		orphanedDepths.should.deepEqual([])
	})

	it("lets flushNow finish when it waits on a flush that started while the previous cycle was settling", async () => {
		// The follow-up flush resolves on a timer, as real I/O does, so a
		// flushNow that spun on microtasks instead of awaiting its handle would
		// never let it finish.
		for (let depth = 0; depth <= 8; depth += 1) {
			let releaseFirst: (() => void) | undefined
			let flushCount = 0
			const scheduler = new TaskPresentationScheduler({
				flush: () => {
					flushCount += 1
					if (flushCount === 1) {
						return new Promise<void>((resolve) => {
							releaseFirst = resolve
						})
					}
					return new Promise<void>((resolve) => setTimeout(resolve, 0))
				},
				getDelayMs: () => 0,
			})

			scheduler.requestFlush("immediate")
			releaseFirst?.()
			let gap = Promise.resolve()
			for (let step = 0; step < depth; step += 1) gap = gap.then(() => undefined)
			let afterSettle = gap.then(() => scheduler.requestFlush("immediate"))
			for (let step = 0; step < 10; step += 1) afterSettle = afterSettle.then(() => undefined)

			await afterSettle.then(() => scheduler.flushNow())

			flushCount.should.be.aboveOrEqual(2)
			await scheduler.dispose()
		}
	})

	it("runs an immediate follow-up flush requested during an in-flight flush", async () => {
		let resolveFirstFlush: (() => void) | undefined
		let flushCount = 0

		const scheduler = new TaskPresentationScheduler({
			flush: async () => {
				flushCount += 1
				if (flushCount === 1) {
					await new Promise<void>((resolve) => {
						resolveFirstFlush = resolve
					})
				}
			},
			getDelayMs: () => 0,
		})

		scheduler.requestFlush("immediate")
		await Promise.resolve()
		await Promise.resolve()

		scheduler.requestFlush("immediate")
		resolveFirstFlush?.()

		await scheduler.flushNow()
		flushCount.should.equal(3)
	})

	it("isolates a reset in-flight flush from the next presentation generation", async () => {
		let rejectFirstFlush: ((error: Error) => void) | undefined
		let flushCount = 0
		const onFlushError = vi.fn()

		const scheduler = new TaskPresentationScheduler({
			flush: async () => {
				flushCount += 1
				if (flushCount === 1) {
					await new Promise<void>((_, reject) => {
						rejectFirstFlush = reject
					})
				}
			},
			getDelayMs: () => 0,
			onFlushError,
		})

		scheduler.requestFlush("immediate")
		await Promise.resolve()
		scheduler.reset()
		scheduler.requestFlush("immediate")

		rejectFirstFlush?.(new Error("Dline instance aborted"))
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()

		flushCount.should.equal(2)
		onFlushError.mock.calls.length.should.equal(0)
	})

	it("reset() cancels pending timers without marking the scheduler as disposed", () => {
		const clock = vi.useFakeTimers()
		const flushSpy = vi.fn(async () => {})

		const scheduler = new TaskPresentationScheduler({
			flush: flushSpy,
			getDelayMs: () => 50,
		})

		scheduler.requestFlush("normal")
		scheduler.reset()

		// The pending timer should have been cancelled
		clock.advanceTimersByTime(100)
		flushSpy.mock.calls.length.should.equal(0)

		// Scheduler should still be usable after reset (not disposed)
		scheduler.requestFlush("normal")
		clock.advanceTimersByTime(50)
		flushSpy.mock.calls.length.should.equal(1)

		clock.useRealTimers()
	})

	it("immediate priority bypasses the timer and flushes synchronously", () => {
		const clock = vi.useFakeTimers()
		const flushSpy = vi.fn(async () => {})

		const scheduler = new TaskPresentationScheduler({
			flush: flushSpy,
			getDelayMs: () => 100,
		})

		scheduler.requestFlush("immediate")
		// immediate fires via void runFlushCycle, which starts synchronously
		flushSpy.mock.calls.length.should.equal(1)

		clock.useRealTimers()
	})

	it("upgrades a pending normal timer to immediate when immediate is requested", () => {
		const clock = vi.useFakeTimers()
		const flushSpy = vi.fn(async () => {})

		const scheduler = new TaskPresentationScheduler({
			flush: flushSpy,
			getDelayMs: () => 100,
		})

		scheduler.requestFlush("normal")
		clock.advanceTimersByTime(50)
		flushSpy.mock.calls.length.should.equal(0)

		// Upgrade to immediate — should cancel the timer and flush now
		scheduler.requestFlush("immediate")
		flushSpy.mock.calls.length.should.equal(1)

		// Original timer should not fire again
		clock.advanceTimersByTime(100)
		flushSpy.mock.calls.length.should.equal(1)

		clock.useRealTimers()
	})

	it("does not report in-flight flush errors after dispose", async () => {
		let rejectFlush: ((error: Error) => void) | undefined
		const onFlushError = vi.fn()

		const scheduler = new TaskPresentationScheduler({
			flush: async () => {
				await new Promise<void>((_, reject) => {
					rejectFlush = reject
				})
			},
			getDelayMs: () => 0,
			onFlushError,
		})

		scheduler.requestFlush("immediate")
		await Promise.resolve()

		await scheduler.dispose()
		rejectFlush?.(new Error("Dline instance aborted"))
		await Promise.resolve()
		await Promise.resolve()

		onFlushError.mock.calls.length.should.equal(0)
	})
})
