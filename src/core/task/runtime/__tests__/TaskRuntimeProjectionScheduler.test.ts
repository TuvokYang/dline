import { describe, expect, it, vi } from "vitest"
import type { TaskSnapshot } from "../../TaskSnapshot"
import { TaskSnapshotPersistence } from "../../TaskSnapshotPersistence"
import {
	type DeferredProjectionFailure,
	type TaskRuntimeProjectionPorts,
	TaskRuntimeProjectionScheduler,
} from "../TaskRuntimeProjectionScheduler"

/** Drive the trailing window explicitly so coalescing is observable without wall-clock waits. */
class ManualClock {
	private pending: Array<{ id: number; run: () => void }> = []
	private nextId = 1
	/** Work started by a fired timer, so a tick can await it instead of guessing microtask depth. */
	private started: Array<Promise<unknown>> = []

	readonly setTimeoutFn = ((run: () => void) => {
		const id = this.nextId++
		this.pending.push({ id, run })
		return id as unknown as ReturnType<typeof setTimeout>
	}) as unknown as typeof setTimeout

	readonly clearTimeoutFn = ((handle: unknown) => {
		this.pending = this.pending.filter((timer) => timer.id !== handle)
	}) as unknown as typeof clearTimeout

	get armed(): number {
		return this.pending.length
	}

	/** Track a promise the test knows a timer will start. */
	track(work: Promise<unknown>): void {
		this.started.push(work.catch(() => undefined))
	}

	/** Fire every armed timer once; the caller awaits the scheduler's own settlement. */
	fire(): void {
		const due = this.pending
		this.pending = []
		for (const timer of due) timer.run()
	}
}

/**
 * Fire the trailing timer and await the deferred work it starts.
 *
 * whenSettled is the scheduler's own settlement point, so this cannot drift
 * out of step with the internal promise-chain depth.
 */
async function tick(clock: ManualClock, scheduler: TaskRuntimeProjectionScheduler): Promise<void> {
	clock.fire()
	await scheduler.whenSettled()
}

function snapshotAt(revision: number): TaskSnapshot {
	return { taskId: "task-1", revision } as unknown as TaskSnapshot
}

const ORIGIN = { effectId: "task-effect-7-2", originRevision: 7 }

interface Harness {
	scheduler: TaskRuntimeProjectionScheduler
	clock: ManualClock
	deferredFailures: DeferredProjectionFailure[]
	ports: {
		postView: ReturnType<typeof vi.fn>
		scheduleSnapshot: ReturnType<typeof vi.fn>
		flushSnapshot: ReturnType<typeof vi.fn>
	}
}

function createHarness(overrides: Partial<TaskRuntimeProjectionPorts> = {}): Harness {
	const clock = new ManualClock()
	const deferredFailures: DeferredProjectionFailure[] = []
	const ports = {
		postView: vi.fn(async () => undefined),
		scheduleSnapshot: vi.fn(() => undefined),
		flushSnapshot: vi.fn(async () => undefined),
	}
	const scheduler = new TaskRuntimeProjectionScheduler({
		ports: {
			...ports,
			onDeferredFailure: (failure) => deferredFailures.push(failure),
			...overrides,
		} as TaskRuntimeProjectionPorts,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	})
	return { scheduler, clock, deferredFailures, ports }
}

describe("TaskRuntimeProjectionScheduler snapshot durability", () => {
	it("retains a coalesced snapshot without forcing a write", async () => {
		const { scheduler, ports } = createHarness()

		await scheduler.persistSnapshot(snapshotAt(1), "scheduled", ORIGIN)

		expect(ports.scheduleSnapshot).toHaveBeenCalledTimes(1)
		expect(ports.flushSnapshot).not.toHaveBeenCalled()
	})

	it("forces a write for a barrier snapshot", async () => {
		const { scheduler, ports } = createHarness()

		await scheduler.persistSnapshot(snapshotAt(1), "flushed", ORIGIN)

		expect(ports.scheduleSnapshot).toHaveBeenCalledTimes(1)
		expect(ports.flushSnapshot).toHaveBeenCalledTimes(1)
	})

	it("always offers the latest snapshot so a later barrier writes current state", async () => {
		const { scheduler, ports } = createHarness()

		await scheduler.persistSnapshot(snapshotAt(1), "scheduled", ORIGIN)
		await scheduler.persistSnapshot(snapshotAt(2), "scheduled", ORIGIN)
		await scheduler.persistSnapshot(snapshotAt(3), "flushed", ORIGIN)

		expect(ports.scheduleSnapshot.mock.calls.map(([snapshot]) => (snapshot as TaskSnapshot).revision)).toEqual([1, 2, 3])
		expect(ports.flushSnapshot).toHaveBeenCalledTimes(1)
	})

	it("passes a distinct snapshot object per call so persistence identity stays per-request", async () => {
		const { scheduler, ports } = createHarness()

		await scheduler.persistSnapshot(snapshotAt(1), "scheduled", ORIGIN)
		await scheduler.persistSnapshot(snapshotAt(2), "scheduled", ORIGIN)

		expect(ports.scheduleSnapshot.mock.calls[0][0]).not.toBe(ports.scheduleSnapshot.mock.calls[1][0])
	})

	it("propagates a barrier write failure to its caller", async () => {
		const { scheduler } = createHarness({
			flushSnapshot: vi.fn(async () => {
				throw new Error("disk full")
			}),
		})

		await expect(scheduler.persistSnapshot(snapshotAt(1), "flushed", ORIGIN)).rejects.toThrow("disk full")
	})
})

describe("TaskRuntimeProjectionScheduler coalescing", () => {
	it("collapses many coalesced transitions into one trailing projection", async () => {
		const { scheduler, clock, ports } = createHarness()

		for (let index = 0; index < 32; index++) {
			await scheduler.persistSnapshot(snapshotAt(index + 1), "scheduled", ORIGIN)
			await scheduler.postView("scheduled", ORIGIN)
		}
		expect(ports.postView).not.toHaveBeenCalled()
		expect(ports.flushSnapshot).not.toHaveBeenCalled()

		await tick(clock, scheduler)

		expect(ports.postView).toHaveBeenCalledTimes(1)
		expect(ports.flushSnapshot).toHaveBeenCalledTimes(1)
	})

	it("projects immediately for a barrier transition", async () => {
		const { scheduler, ports } = createHarness()

		await scheduler.postView("flushed", ORIGIN)

		expect(ports.postView).toHaveBeenCalledTimes(1)
		// A view barrier owes only the view; it must not manufacture a snapshot
		// write for a transition that never asked for one.
		expect(ports.flushSnapshot).not.toHaveBeenCalled()
	})

	it("settles coalesced work owed from earlier transitions at the next barrier", async () => {
		const { scheduler, ports } = createHarness()

		await scheduler.persistSnapshot(snapshotAt(1), "scheduled", ORIGIN)
		await scheduler.postView("flushed", ORIGIN)

		expect(ports.postView).toHaveBeenCalledTimes(1)
		expect(ports.flushSnapshot).toHaveBeenCalledTimes(1)
	})

	it("does not leave a stale trailing projection armed after a barrier", async () => {
		const { scheduler, clock, ports } = createHarness()

		await scheduler.postView("scheduled", ORIGIN)
		await scheduler.postView("flushed", ORIGIN)
		expect(ports.postView).toHaveBeenCalledTimes(1)

		await tick(clock, scheduler)

		expect(ports.postView).toHaveBeenCalledTimes(1)
		expect(scheduler.hasPendingProjection).toBe(false)
	})

	it("re-arms after a trailing projection so later transitions are still projected", async () => {
		const { scheduler, clock, ports } = createHarness()

		await scheduler.postView("scheduled", ORIGIN)
		await tick(clock, scheduler)
		expect(ports.postView).toHaveBeenCalledTimes(1)

		await scheduler.postView("scheduled", ORIGIN)
		await tick(clock, scheduler)

		expect(ports.postView).toHaveBeenCalledTimes(2)
	})
})

describe("TaskRuntimeProjectionScheduler deferred failure attribution", () => {
	it("reports a deferred view failure against the transition that scheduled it", async () => {
		const { scheduler, clock, deferredFailures } = createHarness({
			postView: vi.fn(async () => {
				throw new Error("view build failed")
			}),
		})

		await scheduler.postView("scheduled", { effectId: "task-effect-4-1", originRevision: 4 })
		await tick(clock, scheduler)

		expect(deferredFailures).toHaveLength(1)
		expect(deferredFailures[0].origin).toEqual({ effectId: "task-effect-4-1", originRevision: 4 })
		expect(String((deferredFailures[0].error as Error).message)).toContain("view build failed")
	})

	it("reports a deferred snapshot failure rather than losing it", async () => {
		const { scheduler, clock, deferredFailures } = createHarness({
			flushSnapshot: vi.fn(async () => {
				throw new Error("snapshot write failed")
			}),
		})

		await scheduler.persistSnapshot(snapshotAt(1), "scheduled", { effectId: "task-effect-9-2", originRevision: 9 })
		await tick(clock, scheduler)

		expect(deferredFailures).toHaveLength(1)
		expect(deferredFailures[0].origin).toEqual({ effectId: "task-effect-9-2", originRevision: 9 })
		expect(deferredFailures[0].effectType).toBe("PERSIST_SNAPSHOT")
	})

	it("attributes each deferred failure to the newest coalesced transition, not an unrelated later one", async () => {
		const { scheduler, clock, deferredFailures } = createHarness({
			flushSnapshot: vi.fn(async () => {
				throw new Error("snapshot write failed")
			}),
		})

		await scheduler.persistSnapshot(snapshotAt(1), "scheduled", { effectId: "task-effect-4-2", originRevision: 4 })
		await scheduler.persistSnapshot(snapshotAt(2), "scheduled", { effectId: "task-effect-5-2", originRevision: 5 })
		await tick(clock, scheduler)

		expect(deferredFailures).toHaveLength(1)
		expect(deferredFailures[0].origin.originRevision).toBe(5)
	})

	it("does not report a deferred failure to a later barrier caller", async () => {
		let shouldFail = true
		const { scheduler, clock } = createHarness({
			postView: vi.fn(async () => {
				if (shouldFail) {
					shouldFail = false
					throw new Error("view build failed")
				}
			}),
		})

		await scheduler.postView("scheduled", ORIGIN)
		await tick(clock, scheduler)

		// The later barrier succeeded on its own terms, so it must resolve.
		await expect(scheduler.postView("flushed", ORIGIN)).resolves.toBeUndefined()
	})

	it("retries a failed coalesced projection at the next barrier instead of dropping it", async () => {
		let failNext = true
		const flushSnapshot = vi.fn(async () => {
			if (failNext) {
				failNext = false
				throw new Error("snapshot write failed")
			}
		})
		const { scheduler, clock } = createHarness({ flushSnapshot })

		await scheduler.persistSnapshot(snapshotAt(1), "scheduled", ORIGIN)
		await tick(clock, scheduler)
		expect(flushSnapshot).toHaveBeenCalledTimes(1)

		await scheduler.postView("flushed", ORIGIN)

		expect(flushSnapshot).toHaveBeenCalledTimes(2)
	})

	it("keeps projecting after a failure rather than wedging the chain", async () => {
		let calls = 0
		const { scheduler } = createHarness({
			postView: vi.fn(async () => {
				calls++
				if (calls === 1) throw new Error("view build failed")
			}),
		})

		await expect(scheduler.postView("flushed", ORIGIN)).rejects.toThrow("view build failed")
		await expect(scheduler.postView("flushed", ORIGIN)).resolves.toBeUndefined()
		expect(calls).toBe(2)
	})
})

describe("TaskRuntimeProjectionScheduler teardown", () => {
	it("drops a pending projection once disposed so it cannot outlive the task", async () => {
		const { scheduler, clock, ports } = createHarness()

		await scheduler.postView("scheduled", ORIGIN)
		scheduler.dispose()
		await tick(clock, scheduler)

		expect(ports.postView).not.toHaveBeenCalled()
		expect(scheduler.hasPendingProjection).toBe(false)
	})

	it("ignores further coalesced requests after disposal", async () => {
		const { scheduler, clock, ports } = createHarness()

		scheduler.dispose()
		await scheduler.postView("scheduled", ORIGIN)
		await tick(clock, scheduler)

		expect(ports.postView).not.toHaveBeenCalled()
		expect(clock.armed).toBe(0)
	})
})

describe("TaskRuntimeProjectionScheduler over real snapshot persistence", () => {
	/**
	 * The cost claim is about physical writes, so this drives the real
	 * TaskSnapshotPersistence rather than counting calls to a double.
	 */
	it("performs far fewer writes than a parallel turn has blocks", async () => {
		const clock = new ManualClock()
		const writes: TaskSnapshot[] = []
		const persistence = new TaskSnapshotPersistence({
			writeSnapshot: async (snapshot) => {
				writes.push(snapshot)
			},
			setTimeoutFn: clock.setTimeoutFn,
			clearTimeoutFn: clock.clearTimeoutFn,
		})
		const scheduler = new TaskRuntimeProjectionScheduler({
			ports: {
				postView: async () => {},
				scheduleSnapshot: (snapshot) => persistence.schedule(snapshot),
				flushSnapshot: () => persistence.flushNow(),
			},
			setTimeoutFn: clock.setTimeoutFn,
			clearTimeoutFn: clock.clearTimeoutFn,
		})

		const blocks = 32
		for (let index = 0; index < blocks; index++) {
			await scheduler.persistSnapshot(snapshotAt(index + 1), "scheduled", ORIGIN)
			await scheduler.postView("scheduled", ORIGIN)
		}
		// The turn ends on a barrier.
		await scheduler.persistSnapshot(snapshotAt(blocks + 1), "flushed", ORIGIN)

		expect(writes.length).toBeLessThan(blocks)
		expect(writes.length).toBe(1)
		expect(writes[0].revision).toBe(blocks + 1)
	})
})
