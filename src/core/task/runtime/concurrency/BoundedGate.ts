/**
 * A permit held by admitted work.
 *
 * The permit is released explicitly rather than when an awaiting promise
 * settles. Those are not the same event: a cancelled subagent runner returns
 * while the tool it abandoned keeps running, and releasing on the return would
 * let the gate admit replacement work against resources that are still held.
 */
export interface GatePermit {
	/**
	 * Release the permit.
	 *
	 * Call this only when the admitted work has actually stopped. Repeated
	 * calls are ignored, so a caller may release defensively in a finally block
	 * without double-counting capacity.
	 */
	release(): void
}

/** Observable state of the gate. */
export interface GateState {
	/** Permits currently held. */
	running: number
	/** Callers waiting for a permit. */
	queued: number
	/** Limit in force for the next admission decision. */
	limit: number
}

/** Construction options for a bounded gate. */
export interface BoundedGateOptions {
	/**
	 * Current limit, read on every admission decision.
	 *
	 * Supplying a function rather than a number is what makes the limit a
	 * runtime setting: a saturated provider is retuned by changing the setting,
	 * not by restarting the task or shipping a patch.
	 */
	limit: number | (() => number)
	/** Optional name used in diagnostics. */
	name?: string
}

interface Waiter {
	/** Monotonic arrival sequence, so admission order is defined. */
	seq: number
	resolve(permit: GatePermit): void
	reject(reason: unknown): void
	signal?: AbortSignal
	onAbort?: () => void
	settled: boolean
}

/** Error thrown when a waiter's AbortSignal fires before admission. */
export class GateAbortError extends Error {
	constructor(gateName: string) {
		super(`Gate wait aborted: ${gateName}`)
		this.name = "GateAbortError"
	}
}

/**
 * Bounded concurrency gate with a dynamic limit.
 *
 * Each pool constructs its own gate, so the tool pool and the subagent pool
 * have independent capacity. They must: subagent fan-out saturates provider
 * capacity while tool concurrency saturates local editor and process
 * resources, and one has to be throttleable without throttling the other.
 *
 * The gate is a cooperative primitive, not a mutex. It bounds how many callers
 * proceed; it does not police what they then do.
 */
export class BoundedGate {
	private readonly resolveLimit: () => number
	private readonly name: string
	private waiters: Waiter[] = []
	private held = 0
	private nextSeq = 0
	/**
	 * Allowance withheld for work that outlived its permit.
	 *
	 * Counted separately from `held` because the permit is already gone: the
	 * work is no longer cancellable through the gate, but it still consumes
	 * the resource the limit exists to protect.
	 */
	private withheld = 0

	constructor(options: BoundedGateOptions) {
		const { limit } = options
		this.resolveLimit = typeof limit === "function" ? limit : () => limit
		this.name = options.name ?? "gate"
	}

	/**
	 * Current admission ceiling.
	 *
	 * Capacity withheld for escaped work is subtracted here rather than
	 * counted as running, so a stuck tool narrows the gate instead of being
	 * double counted or silently forgiven.
	 */
	get limit(): number {
		return Math.max(0, this.configuredLimit - this.withheld)
	}

	/** Configured limit, clamped to a non-negative integer. */
	private get configuredLimit(): number {
		const raw = this.resolveLimit()
		if (!Number.isFinite(raw)) {
			return 0
		}
		return Math.max(0, Math.floor(raw))
	}

	/**
	 * Withhold one unit of allowance until the given work settles.
	 *
	 * Used when a permit must be returned before its work actually stopped:
	 * the queue keeps draining, but the gate does not pretend the resource is
	 * free. The allowance returns automatically once the work ends.
	 *
	 * @param until Settles when the escaped work stops.
	 */
	withholdCapacity(until: Promise<unknown>): void {
		this.withheld += 1
		void Promise.resolve(until)
			.catch(() => undefined)
			.finally(() => {
				this.withheld = Math.max(0, this.withheld - 1)
				this.admitWaiters()
			})
	}

	/** Snapshot of running and queued counts. */
	get state(): GateState {
		return { running: this.held, queued: this.waiters.length, limit: this.limit }
	}

	/**
	 * Acquire a permit, waiting if the gate is full.
	 *
	 * @param signal Optional signal that abandons the wait. Aborting affects
	 *   only a caller that has not yet been admitted; work already holding a
	 *   permit is cancelled through its own mechanism, not by the gate.
	 * @returns A permit whose release the caller owns.
	 * @throws GateAbortError when the signal fires before admission.
	 */
	acquire(signal?: AbortSignal): Promise<GatePermit> {
		if (signal?.aborted) {
			return Promise.reject(new GateAbortError(this.name))
		}

		// An existing waiter owns available capacity before a new caller may
		// take it. Without this, a limit raised while waiters are queued can be
		// consumed by whoever arrives next, and the older waiter is left behind
		// until an unrelated completion happens to wake it.
		if (this.waiters.length === 0 && this.held < this.limit) {
			this.held += 1
			return Promise.resolve(this.createPermit())
		}

		return new Promise<GatePermit>((resolve, reject) => {
			const waiter: Waiter = {
				seq: this.nextSeq++,
				resolve,
				reject,
				signal,
				settled: false,
			}

			if (signal) {
				waiter.onAbort = () => {
					if (waiter.settled) return
					waiter.settled = true
					this.waiters = this.waiters.filter((candidate) => candidate !== waiter)
					reject(new GateAbortError(this.name))
				}
				signal.addEventListener("abort", waiter.onAbort, { once: true })
			}

			this.waiters.push(waiter)

			// Capacity may already exist — the limit can have been raised while
			// earlier waiters were queued. Draining here keeps the queue-first
			// rule from turning free capacity into an indefinite wait.
			this.admitWaiters()
		})
	}

	/**
	 * Run work while holding a permit.
	 *
	 * The permit is released when `work` settles, so this helper is correct only
	 * when settling means the work has stopped. Work that outlives its promise —
	 * an abandoned runner, a detached process — must call {@link acquire} and
	 * release when the work itself ends.
	 *
	 * @param work Function to run under the permit.
	 * @param signal Optional signal that abandons the wait for a permit.
	 * @returns The result of `work`.
	 */
	async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const permit = await this.acquire(signal)
		try {
			return await work()
		} finally {
			permit.release()
		}
	}

	/**
	 * Re-check the limit and admit queued work.
	 *
	 * Raising the limit must take effect immediately rather than on the next
	 * unrelated completion, so the owner of the setting calls this when the
	 * value changes. Lowering the limit stops further admission; it never
	 * aborts work that is already running, whose side effects have begun.
	 */
	notifyLimitChanged(): void {
		this.admitWaiters()
	}

	private createPermit(): GatePermit {
		let released = false
		return {
			release: () => {
				if (released) return
				released = true
				this.held = Math.max(0, this.held - 1)
				this.admitWaiters()
			},
		}
	}

	private admitWaiters(): void {
		// Admit in arrival order so continuous arrivals cannot starve an older
		// waiter. The limit is re-read each iteration because the setting may
		// change while a batch is being admitted.
		this.waiters.sort((a, b) => a.seq - b.seq)

		while (this.waiters.length > 0 && this.held < this.limit) {
			const waiter = this.waiters.shift()
			if (!waiter || waiter.settled) continue

			waiter.settled = true
			if (waiter.signal && waiter.onAbort) {
				waiter.signal.removeEventListener("abort", waiter.onAbort)
			}

			this.held += 1
			waiter.resolve(this.createPermit())
		}
	}
}
