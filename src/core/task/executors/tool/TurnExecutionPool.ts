import { telemetryService } from "@/services/telemetry"
import { type AdmissionBlock, type AdmissionRefusal, decideAdmission, poolHasDrained } from "../../kernel/turn/pool-admission"
import { BoundedGate, type GatePermit } from "../../runtime/concurrency/BoundedGate"

/**
 * Resource-aware execution pool for one turn.
 *
 * Two different limits govern a block: how many executions the user permits at
 * once, and which shared resources an execution needs exclusively. The gate
 * answers the first and `decideAdmission` answers the second, and the pool is
 * the only place that owns both. Keeping them separate is deliberate — a
 * counting semaphore cannot express lane exclusivity, and a lane table cannot
 * express a user-tunable ceiling.
 *
 * The pool schedules; it does not decide whether work is allowed. Approval was
 * settled before a block ever reaches here.
 */

/** A block queued for execution, carrying its unstarted effect. */
export interface PooledBlock<T> extends AdmissionBlock {
	/**
	 * The side effect, deliberately not started.
	 *
	 * The pool receives it unstarted so that capacity, lanes and the turn
	 * barrier are decided before anything touches the world. A promise handed
	 * in already running would have to be cancelled rather than merely refused.
	 */
	run(signal: AbortSignal): Promise<T>
}

/** Why a block is not running yet, projected for the UI. */
export type PooledWaitReason = AdmissionRefusal

/** Observable state of one pooled block. */
export type PooledBlockState =
	/** Waiting for capacity, a lane, or the drain barrier. */
	| { status: "queued"; reason: PooledWaitReason }
	/** Holding a permit and executing. */
	| { status: "running" }
	/** Finished normally. */
	| { status: "settled" }
	/** Aborted before or during execution. */
	| { status: "cancelled" }
	/** Suppressed because an earlier turn-ending block closed the turn. */
	| { status: "skipped" }

/** Outcome of one pooled block. */
export interface PooledOutcome<T> {
	dlineTid: string
	index: number
	/** Present when the block ran to completion. */
	value?: T
	/** Present when the block threw. */
	error?: unknown
	/** True when the block was cancelled rather than run. */
	cancelled: boolean
	/** True when an earlier turn-ending block made this call unreachable. */
	skipped?: boolean
}

/** Construction options for a turn execution pool. */
export interface TurnExecutionPoolOptions {
	/**
	 * Current concurrency limit, re-read on every admission decision.
	 *
	 * A function rather than a number, so lowering the limit mid-turn applies
	 * to the next decision without restarting the task.
	 */
	limit: number | (() => number)
	/** Optional name used in diagnostics. */
	name?: string
	/**
	 * Called whenever a block's observable state changes.
	 *
	 * The pool reports rather than renders: queued work must be visible as
	 * queued, not as an idle row the user cannot explain.
	 */
	onStateChange?: (dlineTid: string, state: PooledBlockState) => void
}

interface PooledEntry<T> {
	block: PooledBlock<T>
	controller: AbortController
	state: PooledBlockState
	/**
	 * When the block was submitted, used as the origin of its queue wait.
	 *
	 * The wait has to be measured from here rather than from the start of
	 * `start()`: admission is decided in `schedule()`, so by the time `start()`
	 * runs the gate hands over a permit immediately and a timer opened there
	 * would report roughly zero no matter how long the block actually queued.
	 */
	submittedAt: number
	settle(outcome: PooledOutcome<T>): void
}

/**
 * Executes one turn's approved blocks under a limit and lane exclusivity.
 *
 * The pool is single-turn by construction. A turn's blocks share an ordering,
 * a drain barrier and a cancellation scope, and reusing one pool across turns
 * would blur all three.
 */
/**
 * Distinguishes concurrent pools in telemetry without becoming a metric label.
 *
 * Several turns can be in flight at once, and their samples would otherwise
 * overwrite one another under the shared `pool` label. The counter stays
 * process-local: it identifies a reporter, never a user or a task.
 */
let nextPoolInstanceId = 0

export class TurnExecutionPool<T> {
	private readonly telemetryInstance = `turn-pool-${++nextPoolInstanceId}`
	private readonly gate: BoundedGate
	private readonly limit: () => number
	private readonly onStateChange?: TurnExecutionPoolOptions["onStateChange"]
	private readonly entries = new Map<string, PooledEntry<T>>()
	private readonly pending: PooledBlock<T>[] = []
	private readonly running = new Map<string, AdmissionBlock>()
	private readonly outcomes: PooledOutcome<T>[] = []
	private hasUnfinishedEarlierWork = false
	/** Once set, no later sibling in this turn may start. */
	private turnEndingIndex?: number
	private disposed = false

	constructor(options: TurnExecutionPoolOptions) {
		// A pool that admits work it can never give a permit to is worse than a
		// slow one: admission deliberately lets a drained turn-ending block
		// through even at zero capacity, and the gate would then park it
		// forever. One is the smallest limit that keeps both answers the same.
		const usableLimit = () => {
			const configured = typeof options.limit === "function" ? options.limit() : options.limit
			return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 1
		}
		this.limit = usableLimit
		this.gate = new BoundedGate({ limit: usableLimit, name: options.name ?? "turn-execution-pool" })
		this.onStateChange = options.onStateChange
	}

	/** Blocks currently holding a permit. */
	get runningCount(): number {
		return this.running.size
	}

	/** Blocks admitted to the pool but not yet started. */
	get queuedCount(): number {
		return this.pending.length
	}

	/**
	 * Declare that work outside the pool is still outstanding.
	 *
	 * A turn-ending block must wait for everything, including blocks that are
	 * neither running nor pending because they are still streaming. Without
	 * this the barrier would only see the pool's own view and could release
	 * early.
	 *
	 * @param outstanding True while earlier work has not reached a terminal phase.
	 */
	setUnfinishedEarlierWork(outstanding: boolean): void {
		const wasOutstanding = this.hasUnfinishedEarlierWork
		this.hasUnfinishedEarlierWork = outstanding
		if (wasOutstanding && !outstanding) {
			// Clearing the flag is the only direction that can admit work, and
			// the block it releases is the turn-ending one. Leaving that to the
			// next unrelated event would stall the turn waiting on nothing.
			this.schedule()
		}
	}

	/**
	 * Whether the pool and its declared outside work have drained.
	 *
	 * @returns True when a turn-ending block may start.
	 */
	hasDrained(): boolean {
		return poolHasDrained({
			running: [...this.running.values()],
			hasUnfinishedEarlierWork: this.hasUnfinishedEarlierWork,
		})
	}

	/**
	 * Queue a block and resolve when it has settled or been cancelled.
	 *
	 * @param block The block and its unstarted effect.
	 * @returns The outcome, which never rejects: a thrown effect is reported as
	 *   an error outcome so one failing block cannot abandon the rest of the turn.
	 */
	submit(block: PooledBlock<T>): Promise<PooledOutcome<T>> {
		if (this.disposed) {
			// A block submitted after cancellation still needs a recorded
			// outcome, because the turn must account for every call the model
			// made rather than quietly losing one.
			const outcome: PooledOutcome<T> = { dlineTid: block.dlineTid, index: block.index, cancelled: true }
			this.outcomes.push(outcome)
			return Promise.resolve(outcome)
		}

		return new Promise<PooledOutcome<T>>((resolve) => {
			let settled = false
			const entry: PooledEntry<T> = {
				block,
				controller: new AbortController(),
				state: { status: "queued", reason: "limit_reached" },
				submittedAt: Date.now(),
				settle: (outcome) => {
					// Cancellation can reach a block that has already left the
					// queue but not yet started, so the canceller and the runner
					// both try to settle it. The first one wins: a second
					// outcome would duplicate the block in the ordered results
					// the model is shown.
					if (settled) {
						return
					}
					settled = true
					this.outcomes.push(outcome)
					resolve(outcome)
				},
			}
			this.entries.set(block.dlineTid, entry)
			this.pending.push(block)
			if (this.turnEndingIndex !== undefined && block.index > this.turnEndingIndex) {
				this.skip(block.dlineTid)
			} else {
				this.schedule()
			}
		})
	}

	/**
	 * Cancel one block.
	 *
	 * A queued block never starts; a running block has its signal aborted and
	 * is expected to stop. Either way the block reaches an explicit cancelled
	 * state rather than silently disappearing, because a restart must be able
	 * to tell "cancelled" from "still running".
	 *
	 * @param dlineTid Identity of the block to cancel.
	 */
	cancel(dlineTid: string): void {
		const entry = this.entries.get(dlineTid)
		if (
			!entry ||
			entry.state.status === "settled" ||
			entry.state.status === "cancelled" ||
			entry.state.status === "skipped"
		) {
			return
		}

		const wasQueued = entry.state.status === "queued"
		this.transition(entry, { status: "cancelled" })
		entry.controller.abort()

		if (wasQueued) {
			const index = this.pending.findIndex((candidate) => candidate.dlineTid === dlineTid)
			if (index >= 0) {
				this.pending.splice(index, 1)
			}
		}

		// The outcome is recorded now, for running blocks as well as queued
		// ones. Waiting for the effect to return would make the cancellation
		// depend on the block cooperating with its signal, and a block that
		// ignores it would leave the turn with no result for a call the model
		// made. Resources are still released only when the effect actually
		// ends, so a lane is never handed on while its work continues.
		entry.settle({ dlineTid, index: entry.block.index, cancelled: true })

		if (wasQueued) {
			this.release(dlineTid, undefined)
		}
	}

	/**
	 * Cancel every block the pool owns.
	 *
	 * Used when the turn itself is cancelled. Running work is aborted through
	 * its own signal; the pool does not wait for it here, because a block that
	 * ignores its signal must not be able to block shutdown.
	 */
	cancelAll(): void {
		this.disposed = true
		for (const dlineTid of [...this.entries.keys()]) {
			this.cancel(dlineTid)
		}
		// The turn is over, so this pool must stop contributing to the
		// process-level occupancy. Leaving its last sample behind would keep
		// finished work counted as outstanding for the life of the process.
		telemetryService.forgetPoolInstance("tool", this.telemetryInstance)
	}

	/** Cancel every block after the block that halted the turn. */
	cancelBlocksAfter(haltedIndex: number): void {
		for (const entry of this.entries.values()) {
			if (entry.block.index > haltedIndex) this.cancel(entry.block.dlineTid)
		}
	}

	/** Permanently suppress every later sibling after a turn-ending block starts. */
	private skipBlocksAfter(endingIndex: number): void {
		for (const entry of this.entries.values()) {
			if (entry.block.index > endingIndex) this.skip(entry.block.dlineTid)
		}
	}

	private skip(dlineTid: string): void {
		const entry = this.entries.get(dlineTid)
		if (!entry || entry.state.status !== "queued") return
		const index = this.pending.findIndex((candidate) => candidate.dlineTid === dlineTid)
		if (index >= 0) this.pending.splice(index, 1)
		this.transition(entry, { status: "skipped" })
		entry.settle({ dlineTid, index: entry.block.index, cancelled: false, skipped: true })
		this.release(dlineTid, undefined)
	}

	/** Re-run admission after the configured limit changed. */
	notifyLimitChanged(): void {
		this.gate.notifyLimitChanged()
		this.schedule()
	}

	/**
	 * Outcomes in assistant tool-call order.
	 *
	 * Completion order is not result order: a fast tool finishing first must
	 * not reorder the turn the model sees.
	 */
	orderedOutcomes(): PooledOutcome<T>[] {
		return [...this.outcomes].sort((a, b) => a.index - b.index)
	}

	private schedule(): void {
		const decision = decideAdmission({
			pending: this.pending,
			running: [...this.running.values()],
			limit: this.limit(),
			hasUnfinishedEarlierWork: this.hasUnfinishedEarlierWork,
		})

		for (const { block, reason } of decision.refuse) {
			const entry = this.entries.get(block.dlineTid)
			if (entry && entry.state.status === "queued") {
				this.transition(entry, { status: "queued", reason })
			}
		}

		for (const admitted of decision.admit) {
			// Admission works on the lane-bearing shape, so the entry is the
			// authority for the effect itself; a block without one has already
			// been settled and must not be started again.
			const entry = this.entries.get(admitted.dlineTid)
			const index = this.pending.findIndex((candidate) => candidate.dlineTid === admitted.dlineTid)
			if (index >= 0) {
				this.pending.splice(index, 1)
			}
			if (!entry) {
				continue
			}
			// The block occupies its lanes and a slot from the moment it is
			// admitted, not from the moment its effect starts. Acquiring the
			// permit is asynchronous, and registering only afterwards would let
			// the next decision — taken in between — see an empty pool and
			// admit a block that conflicts with this one.
			this.running.set(entry.block.dlineTid, entry.block)
			void this.start(entry)
		}
	}

	/**
	 * Whether this entry has been cancelled.
	 *
	 * Read through the map rather than a captured reference: cancellation
	 * happens while `start` is suspended, so a narrowed local would describe
	 * the state as it was before the await, not as it is now.
	 */
	private isCancelled(dlineTid: string): boolean {
		return this.entries.get(dlineTid)?.state.status === "cancelled"
	}

	private async start(entry: PooledEntry<T>): Promise<void> {
		const block = entry.block

		// Admission already decided this block may run, so the gate is expected
		// to hand over a permit immediately. It is still acquired rather than
		// assumed, because the gate is the single owner of the running count.
		let permit: GatePermit
		try {
			permit = await this.gate.acquire(entry.controller.signal)
		} catch {
			// The only rejection is an abort, which cancel() has already
			// reported; settling here is the idempotent second attempt that
			// covers an abort arriving before cancel() saw this entry.
			entry.settle({ dlineTid: block.dlineTid, index: block.index, cancelled: true })
			this.release(block.dlineTid, undefined)
			return
		}

		try {
			// Sampled once the permit is in hand: a saturated pool is only
			// distinguishable from an idle one when wait and occupancy are reported together.
			telemetryService.capturePoolAdmission({
				pool: "tool",
				instance: this.telemetryInstance,
				queueWaitMs: Date.now() - entry.submittedAt,
				running: this.runningCount,
				queued: this.queuedCount,
				limit: this.limit(),
			})

			if (this.isCancelled(block.dlineTid)) {
				entry.settle({ dlineTid: block.dlineTid, index: block.index, cancelled: true })
				return
			}

			if (block.isTurnEnding) {
				this.turnEndingIndex = Math.min(this.turnEndingIndex ?? block.index, block.index)
				this.skipBlocksAfter(this.turnEndingIndex)
			}
			this.transition(entry, { status: "running" })
			try {
				const value = await block.run(entry.controller.signal)
				if (this.isCancelled(block.dlineTid)) {
					entry.settle({ dlineTid: block.dlineTid, index: block.index, cancelled: true })
				} else {
					this.transition(entry, { status: "settled" })
					entry.settle({ dlineTid: block.dlineTid, index: block.index, value, cancelled: false })
				}
			} catch (error) {
				if (this.isCancelled(block.dlineTid)) {
					entry.settle({ dlineTid: block.dlineTid, index: block.index, cancelled: true })
				} else {
					this.transition(entry, { status: "settled" })
					entry.settle({ dlineTid: block.dlineTid, index: block.index, error, cancelled: false })
				}
			}
		} finally {
			// Every acquired permit has exactly one release owner.
			this.release(block.dlineTid, permit)
		}
	}

	/** Give up the block's lanes and slot, then let waiting work in. */
	private release(dlineTid: string, permit: GatePermit | undefined): void {
		this.running.delete(dlineTid)
		permit?.release()
		this.schedule()
		// Reported after scheduling so the sample describes the pool a waiting
		// block now sees, rather than the moment before replacements were let
		// in; a series built only from admissions would never fall back to zero.
		telemetryService.recordPoolOccupancy({
			pool: "tool",
			instance: this.telemetryInstance,
			running: this.runningCount,
			queued: this.queuedCount,
			limit: this.limit(),
		})
	}

	private transition(entry: PooledEntry<T>, state: PooledBlockState): void {
		entry.state = state
		try {
			this.onStateChange?.(entry.block.dlineTid, state)
		} catch {
			// The observer reports progress; it does not participate in
			// scheduling. Letting it throw here would abort a settle or strand
			// a permit, turning a presentation failure into a stuck turn.
		}
	}
}
