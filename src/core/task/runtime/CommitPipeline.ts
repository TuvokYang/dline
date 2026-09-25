import type { Command, TaskState } from "../kernel"
import type { StateVault, TaskViewPort } from "../stores/contracts"
import type { CommitReceipt, RuntimeDiagnosticSink } from "./contracts"
import { deferred } from "./deferred"

interface Waiter {
	readonly revision: number
	resolve(): void
	reject(error: Error): void
}

/** Commits that arrived while a write was in flight; they land together. */
interface PendingBatch {
	state: TaskState
	outbox: readonly Command[]
	readonly committed: TaskState[]
	readonly waiters: Waiter[]
}

/**
 * Persists committed kernel states, then shows them.
 *
 * A snapshot is the whole durable truth, so commits that arrive while a write is
 * in flight collapse into one write of the newest snapshot, and every commit of
 * that batch becomes durable when it lands. Durability does not wait for the
 * view: the view is told afterwards, in revision order, and a failing view is a
 * diagnostic, not a lost commit. A failed write is fatal, because no later
 * snapshot can be trusted to follow one that never reached disk.
 */
export class CommitPipeline {
	private pending: PendingBatch | undefined
	private writing: Promise<void> | undefined
	private viewTail: Promise<void> = Promise.resolve()
	private readonly receipts = new Map<number, Promise<void>>()
	private fatalError: Error | undefined

	constructor(
		private readonly vault: StateVault,
		private readonly taskView: TaskViewPort,
		private readonly diagnostics?: RuntimeDiagnosticSink,
	) {}

	commit(state: TaskState, outbox: readonly Command[]): CommitReceipt {
		const completion = deferred<void>()
		const durable = completion.promise
		this.track(state.revision, durable)
		if (this.fatalError) {
			this.recordDurabilityFailure(this.fatalError, state.revision)
			completion.reject(this.fatalError)
			return { revision: state.revision, durable }
		}
		const waiter: Waiter = { revision: state.revision, resolve: completion.resolve, reject: completion.reject }
		if (this.pending) {
			this.pending.state = state
			this.pending.outbox = outbox
			this.pending.committed.push(state)
			this.pending.waiters.push(waiter)
		} else {
			this.pending = { state, outbox, committed: [state], waiters: [waiter] }
		}
		this.writing ??= this.drain()
		return { revision: state.revision, durable }
	}

	/** Resolves once every commit through `revision` is on disk; the view may still be catching up. */
	async flushThrough(revision: number): Promise<void> {
		await Promise.all(
			[...this.receipts.entries()].filter(([candidate]) => candidate <= revision).map(([, receipt]) => receipt),
		)
	}

	/** Resolves once every commit is on disk and the view has been told about all of them. */
	async flushAll(): Promise<void> {
		await Promise.all([...this.receipts.values()])
		await this.viewTail
	}

	private async drain(): Promise<void> {
		try {
			while (this.pending) {
				const batch = this.pending
				this.pending = undefined
				try {
					await this.vault.save({ state: batch.state, outbox: batch.outbox })
				} catch (error) {
					this.fail(error, batch)
					return
				}
				for (const waiter of batch.waiters) waiter.resolve()
				this.publish(batch.committed)
			}
		} finally {
			this.writing = undefined
		}
	}

	private fail(error: unknown, batch: PendingBatch): void {
		const fatal = error instanceof Error ? error : new Error(String(error))
		this.fatalError ??= fatal
		const rejected = [...batch.waiters, ...(this.pending?.waiters ?? [])]
		this.pending = undefined
		for (const waiter of rejected) {
			this.recordDurabilityFailure(fatal, waiter.revision)
			waiter.reject(fatal)
		}
	}

	private publish(states: readonly TaskState[]): void {
		for (const state of states) {
			this.viewTail = this.viewTail
				.then(() => this.taskView.notifyCommitted(state))
				.catch((error) => {
					this.diagnostics?.record({
						source: "commit",
						code: "view_publish_failed",
						message: error instanceof Error ? error.message : String(error),
						revision: state.revision,
					})
				})
		}
	}

	private track(revision: number, durable: Promise<void>): void {
		this.receipts.set(revision, durable)
		void durable
			.finally(() => {
				if (this.receipts.get(revision) === durable) this.receipts.delete(revision)
			})
			.catch(() => undefined)
	}

	private recordDurabilityFailure(error: Error, revision: number): void {
		this.diagnostics?.record({ source: "commit", code: "durability_failed", message: error.message, revision })
	}

	get failed(): boolean {
		return this.fatalError !== undefined
	}
}
