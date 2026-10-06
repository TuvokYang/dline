import type { PresentationPriority } from "./presentation-types"

export type { PresentationPriority }

export interface PresentationFlushContext {
	generation: number
	isCurrent: () => boolean
}

type TaskPresentationSchedulerOptions = {
	flush: (context: PresentationFlushContext) => Promise<void>
	getDelayMs: (priority: PresentationPriority) => number
	setTimeoutFn?: typeof setTimeout
	clearTimeoutFn?: typeof clearTimeout
	onFlushError?: (error: unknown) => void
}

interface PresentationLane {
	scheduledTimer?: ReturnType<typeof setTimeout>
	scheduledPriority?: PresentationPriority
	pendingPriority?: PresentationPriority
	flushInProgress: boolean
	currentFlushCompletion?: Promise<{ error?: unknown }>
}

function createPresentationLane(): PresentationLane {
	return { flushInProgress: false }
}

export class TaskPresentationScheduler {
	private generation = 0
	private lane = createPresentationLane()
	private disposed = false

	private readonly flush: (context: PresentationFlushContext) => Promise<void>
	private readonly getDelayMs: (priority: PresentationPriority) => number
	private readonly setTimeoutFn: typeof setTimeout
	private readonly clearTimeoutFn: typeof clearTimeout
	private readonly onFlushError?: (error: unknown) => void

	constructor(options: TaskPresentationSchedulerOptions) {
		this.flush = options.flush
		this.getDelayMs = options.getDelayMs
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
		this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
		this.onFlushError = options.onFlushError
	}

	requestFlush(priority: PresentationPriority = "normal"): void {
		if (this.disposed) {
			return
		}

		const lane = this.lane
		const generation = this.generation
		lane.pendingPriority = this.mergePriority(lane.pendingPriority, priority)

		if (lane.flushInProgress) {
			return
		}

		if (lane.pendingPriority === "immediate") {
			if (lane.scheduledTimer) {
				this.clearTimeoutFn(lane.scheduledTimer)
				lane.scheduledTimer = undefined
				lane.scheduledPriority = undefined
			}
			void this.runFlushCycle(lane, generation, { rethrowErrors: false })
			return
		}

		const nextPriority = lane.pendingPriority ?? "normal"

		if (lane.scheduledTimer) {
			if (lane.scheduledPriority === nextPriority) {
				return
			}

			this.clearTimeoutFn(lane.scheduledTimer)
			lane.scheduledTimer = undefined
			lane.scheduledPriority = undefined
		}

		if (!lane.pendingPriority) {
			return
		}

		const delayMs = this.getDelayMs(nextPriority)
		lane.scheduledPriority = nextPriority
		lane.scheduledTimer = this.setTimeoutFn(() => {
			lane.scheduledTimer = undefined
			lane.scheduledPriority = undefined
			void this.runFlushCycle(lane, generation, { rethrowErrors: false })
		}, delayMs)
	}

	/**
	 * Flush immediately and await completion.
	 *
	 * Guarantees that at least one flush runs at "immediate" priority after this
	 * call returns, even if a concurrent flush cycle consumed the pending priority
	 * before this call could start its own cycle.
	 *
	 * If the scheduler has already been disposed this is a no-op and resolves
	 * without error. Callers that need a guarantee that the final presentation
	 * was delivered should ensure `dispose()` has not been called before
	 * invoking `flushNow()` (the task streaming finalization path does this
	 * correctly because `dispose()` is only called during `abortTask()`).
	 */
	async flushNow(): Promise<void> {
		if (this.disposed) {
			return
		}

		const lane = this.lane
		const generation = this.generation
		if (lane.scheduledTimer) {
			this.clearTimeoutFn(lane.scheduledTimer)
			lane.scheduledTimer = undefined
			lane.scheduledPriority = undefined
		}

		while (lane.flushInProgress) {
			// A flush in progress always owns a completion handle. Waiting on a
			// substitute instead would spin on microtasks and starve the very
			// I/O that flush needs to finish.
			const inFlight = lane.currentFlushCompletion
			if (!inFlight) {
				throw new Error("Presentation flush is in progress without a completion handle")
			}
			await inFlight
		}

		if (this.disposed || !this.isCurrent(lane, generation)) {
			return
		}

		lane.pendingPriority = this.mergePriority(lane.pendingPriority, "immediate")
		await this.runFlushCycle(lane, generation, { rethrowErrors: true })
	}

	/**
	 * Cancel any pending timers and clear queued state without marking the scheduler
	 * as disposed. Use this between API request retries within the same task to prevent
	 * stale timers from firing against reset streaming state.
	 *
	 * Any flush already in flight remains attached to the previous generation. Its
	 * context becomes stale immediately, so it cannot report errors for or consume
	 * queued work from the new presentation lane.
	 */
	reset(): void {
		if (this.disposed) {
			return
		}
		const staleLane = this.lane
		if (staleLane.scheduledTimer) {
			this.clearTimeoutFn(staleLane.scheduledTimer)
			staleLane.scheduledTimer = undefined
		}
		staleLane.scheduledPriority = undefined
		staleLane.pendingPriority = undefined
		this.generation += 1
		this.lane = createPresentationLane()
	}

	async dispose(): Promise<void> {
		this.disposed = true
		const lane = this.lane
		if (lane.scheduledTimer) {
			this.clearTimeoutFn(lane.scheduledTimer)
			lane.scheduledTimer = undefined
		}
		lane.scheduledPriority = undefined
		lane.pendingPriority = undefined
		this.generation += 1

		// Do not await in-flight flush — it will complete naturally but may be
		// blocked on gRPC writes during multi-controller event-loop contention.
		// Setting disposed = true causes runFlushCycle to exit early on its next
		// iteration, preventing new flushes while letting the current one finish
		// asynchronously without blocking dispose().
	}

	private async runFlushCycle(lane: PresentationLane, generation: number, options: { rethrowErrors: boolean }): Promise<void> {
		if (this.disposed || !this.isCurrent(lane, generation)) {
			return
		}

		while (true) {
			if (lane.flushInProgress) {
				// flushNow() handles the in-flight case itself before calling runFlushCycle,
				// so this branch is only reached from requestFlush() (which returns early when
				// flushInProgress is true) — meaning this path should not be hit in practice.
				// Guard it defensively anyway.
				const inFlightResult = await lane.currentFlushCompletion
				if (options.rethrowErrors && inFlightResult?.error && this.isCurrent(lane, generation)) {
					throw inFlightResult.error
				}
				if (lane.flushInProgress || this.disposed || !this.isCurrent(lane, generation) || !lane.pendingPriority) {
					return
				}
			}

			if (!lane.pendingPriority || !this.isCurrent(lane, generation)) {
				return
			}

			lane.flushInProgress = true
			lane.pendingPriority = undefined
			const context: PresentationFlushContext = {
				generation,
				isCurrent: () => this.isCurrent(lane, generation),
			}

			const completion = (async (): Promise<{ error?: unknown }> => {
				try {
					await this.flush(context)
					return {}
				} catch (error) {
					if (!this.disposed && this.isCurrent(lane, generation)) {
						this.onFlushError?.(error)
					}
					return { error }
				} finally {
					lane.flushInProgress = false
				}
			})()

			lane.currentFlushCompletion = completion
			const result = await completion
			// `flushInProgress` is cleared inside the completion, before this
			// continuation runs. An immediate request landing in that gap starts
			// the next cycle and installs its own handle, which must survive.
			if (lane.currentFlushCompletion === completion) {
				lane.currentFlushCompletion = undefined
			}
			if (result.error && options.rethrowErrors && this.isCurrent(lane, generation)) {
				throw result.error
			}

			if (this.disposed || !this.isCurrent(lane, generation)) {
				return
			}

			const priorityToRun = lane.pendingPriority
			if (!priorityToRun) {
				return
			}

			if (priorityToRun !== "immediate") {
				this.requestFlush(priorityToRun)
				return
			}

			// Continue the loop synchronously for immediate follow-up work queued
			// while this flush ran. A request that arrived after the flush settled
			// but before this continuation may already have started its own cycle;
			// the guard at the top of the loop then waits for it instead.
		}
	}

	private isCurrent(lane: PresentationLane, generation: number): boolean {
		return !this.disposed && this.lane === lane && this.generation === generation
	}

	private mergePriority(current: PresentationPriority | undefined, next: PresentationPriority): PresentationPriority {
		if (!current) {
			return next
		}

		const rank: Record<PresentationPriority, number> = {
			normal: 0,
			immediate: 1,
		}

		return rank[next] > rank[current] ? next : current
	}
}
