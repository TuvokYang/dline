import type { ToolDomainEvent, ToolDomainEventSink } from "./ToolExecutionDomain"

/**
 * Correlates one dispatched tool command with the event that settles it.
 *
 * The executor contract makes `handle` fire-and-forget, but the runtime still
 * needs a point at which the block is known to be finished: the reducer emits
 * `BLOCK_EXECUTION_COMPLETED` only after the tool has actually run, and a tool
 * failure must keep surfacing as a failed effect rather than disappearing.
 *
 * This ledger is the adapter between those two shapes. It lives on the runtime
 * side of the boundary on purpose — the domain stays unaware that anyone is
 * waiting, which is what lets the same domain later serve a batched caller that
 * waits for nothing.
 */

/** Why a tracked command finished without a tool result. */
export class ToolCommandHaltedError extends Error {
	constructor(readonly commandId: string) {
		super(`Tool command was halted before it produced a result: ${commandId}`)
		this.name = "ToolCommandHaltedError"
	}
}

interface PendingCommand {
	resolve(): void
	reject(error: Error): void
}

export class ToolCommandLedger {
	private readonly pending = new Map<string, PendingCommand>()

	/**
	 * Observe one command before it is dispatched.
	 *
	 * Registration precedes dispatch so a synchronously-emitted event cannot
	 * arrive while nothing is listening.
	 */
	track(commandId: string): Promise<void> {
		if (this.pending.has(commandId)) {
			return Promise.reject(new Error(`Tool command is already being tracked: ${commandId}`))
		}
		return new Promise<void>((resolve, reject) => {
			this.pending.set(commandId, { resolve, reject })
		})
	}

	/** The sink handed to the domain. */
	readonly sink: ToolDomainEventSink = {
		emit: (event: ToolDomainEvent): void => {
			switch (event.kind) {
				case "tool.block_result":
					this.settle(event.commandId, undefined)
					return
				case "tool.block_failed":
					// A tool failure must stay a failed effect, so the waiter rejects
					// and the runtime records EFFECT_FAILED exactly as before. The
					// original error is rethrown when available, because wrapping it
					// would drop the subclass, stack and cause chain that the old
					// direct-await path preserved.
					this.settle(event.commandId, event.cause instanceof Error ? event.cause : new Error(event.message))
					return
				case "tool.rejected":
					this.settle(event.commandId, new ToolCommandHaltedError(event.commandId))
					return
				case "tool.halted":
					// A stop drops results produced before it, so those commands would
					// never emit an outcome. Releasing them here is what keeps the halt
					// barrier from stranding every waiter behind it.
					this.releaseAll()
					return
			}
		},
	}

	get pendingCount(): number {
		return this.pending.size
	}

	private settle(commandId: string, error: Error | undefined): void {
		const waiter = this.pending.get(commandId)
		if (!waiter) return
		this.pending.delete(commandId)
		if (error) {
			waiter.reject(error)
			return
		}
		waiter.resolve()
	}

	/**
	 * Fail every outstanding waiter.
	 *
	 * Public because a stop that exceeds its drain budget never delivers a
	 * receipt, and the waiters behind it must still be released rather than
	 * left pending on a tool that may never settle.
	 */
	releaseAll(): void {
		const waiters = [...this.pending.entries()]
		this.pending.clear()
		for (const [commandId, waiter] of waiters) {
			waiter.reject(new ToolCommandHaltedError(commandId))
		}
	}
}
