import type { Command, TaskState } from "../../kernel"
import type { StateVault, TaskViewPort } from "../../stores/contracts"
import type { CommitReceipt, RuntimeDiagnosticSink } from "./contracts"
import { deferred } from "./deferred"

export class CommitPipeline {
	private tail: Promise<void> = Promise.resolve()
	private readonly receipts = new Map<number, Promise<void>>()
	private fatalError: Error | undefined

	constructor(
		private readonly vault: StateVault,
		private readonly taskView: TaskViewPort,
		private readonly diagnostics?: RuntimeDiagnosticSink,
	) {}

	commit(state: TaskState, outbox: readonly Command[]): CommitReceipt {
		const completion = deferred<void>()
		const operation = this.tail.then(async () => {
			if (this.fatalError) throw this.fatalError
			await this.vault.save({ state, outbox })
			await this.taskView.notifyCommitted(state)
		})
		this.tail = operation.catch((error) => {
			const fatal = error instanceof Error ? error : new Error(String(error))
			this.fatalError ??= fatal
			this.diagnostics?.record({
				source: "commit",
				code: "durability_failed",
				message: fatal.message,
				revision: state.revision,
			})
		})
		operation.then(
			() => completion.resolve(),
			(error) => completion.reject(error),
		)
		this.receipts.set(state.revision, completion.promise)
		void completion.promise
			.finally(() => {
				if (this.receipts.get(state.revision) === completion.promise) this.receipts.delete(state.revision)
			})
			.catch(() => undefined)
		return { revision: state.revision, durable: completion.promise }
	}

	async flushThrough(revision: number): Promise<void> {
		await Promise.all(
			[...this.receipts.entries()].filter(([candidate]) => candidate <= revision).map(([, receipt]) => receipt),
		)
	}

	async flushAll(): Promise<void> {
		await Promise.all([...this.receipts.values()])
	}

	get failed(): boolean {
		return this.fatalError !== undefined
	}
}
