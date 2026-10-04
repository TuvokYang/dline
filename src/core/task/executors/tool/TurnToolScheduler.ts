import { resolveMaxParallelToolCalls } from "@shared/concurrency-limits"
import type { ToolRunBlock } from "../../kernel"
import { type PooledOutcome, TurnExecutionPool } from "./TurnExecutionPool"

export interface TurnToolSchedulerOptions {
	/** Persisted `maxParallelToolCalls`, re-read on every admission decision. */
	readConfiguredLimit(): number | undefined
}

/** One kernel-released block together with its unstarted effect. */
export interface ScheduledToolBlock {
	readonly turnId: string
	readonly mode: "serial" | "parallel"
	readonly block: ToolRunBlock
	/** Runs only once the pool grants a slot; the signal aborts on cancellation. */
	run(signal: AbortSignal): Promise<void>
}

interface ActiveTurn {
	readonly turnId: string
	readonly pool: TurnExecutionPool<void>
	/** Assistant-order indices the kernel has released to this pool so far. */
	readonly released: Set<number>
	firstTurnEndingIndex: number | undefined
}

/**
 * The single WS-072 scheduler behind the canonical tool executor.
 *
 * The kernel releases blocks in several `tool.run` commands per turn: the
 * automatically admitted ones first, then each manually approved block as the
 * user answers. Holding one pool per turn lets the user-configured ceiling,
 * lane exclusivity and the turn-ending barrier apply across all of them.
 * Approval is settled before a block arrives here; the scheduler only decides
 * when an approved block may start.
 */
export class TurnToolScheduler {
	private active: ActiveTurn | undefined

	constructor(private readonly options: TurnToolSchedulerOptions) {}

	/** Queue one released block; resolves with the pool's outcome once it settled. */
	schedule(input: ScheduledToolBlock): Promise<PooledOutcome<void>> {
		const turn = this.turnFor(input.turnId, input.mode)
		turn.released.add(input.block.index)
		if (input.block.turnEnding) {
			turn.firstTurnEndingIndex = Math.min(turn.firstTurnEndingIndex ?? input.block.index, input.block.index)
		}
		// The pool decides admission synchronously inside `submit`. A
		// turn-ending block must see the barrier before it is offered; an
		// ordinary block must be in the pool before the barrier it may clear is
		// re-evaluated, otherwise the ending block would slip in ahead of it.
		if (input.block.turnEnding) this.refreshBarrier(turn)
		const outcome = turn.pool.submit({
			dlineTid: input.block.blockId,
			index: input.block.index,
			lanes: input.block.lanes,
			isTurnEnding: input.block.turnEnding,
			run: input.run,
		})
		if (!input.block.turnEnding) this.refreshBarrier(turn)
		return outcome
	}

	/** Cancel every block of the active turn; queued blocks never start. */
	cancelActiveTurn(): void {
		this.active?.pool.cancelAll()
		this.active = undefined
	}

	/** Release the completed turn without allowing a stale retire to cancel its successor. */
	retireTurn(turnId: string): void {
		if (this.active?.turnId !== turnId) return
		this.active.pool.cancelAll()
		this.active = undefined
	}

	/** Re-run admission after the configured ceiling changed. */
	notifyLimitChanged(): void {
		this.active?.pool.notifyLimitChanged()
	}

	private turnFor(turnId: string, mode: ScheduledToolBlock["mode"]): ActiveTurn {
		if (this.active?.turnId === turnId) return this.active
		// A new turn retires the previous pool. Anything still queued there was
		// skipped or cancelled by the kernel, which never releases it again.
		this.active?.pool.cancelAll()
		const parallel = mode === "parallel"
		this.active = {
			turnId,
			pool: new TurnExecutionPool<void>({
				limit: () => resolveMaxParallelToolCalls(this.options.readConfiguredLimit(), parallel),
				name: "turn-tool-pool",
			}),
			released: new Set(),
			firstTurnEndingIndex: undefined,
		}
		return this.active
	}

	/**
	 * A turn-ending block must also wait for earlier siblings the kernel has
	 * not released yet, typically ones still awaiting manual approval. Block
	 * indices are contiguous in assistant order, so an unreleased lower index
	 * is exactly that outstanding work.
	 */
	private refreshBarrier(turn: ActiveTurn): void {
		const ending = turn.firstTurnEndingIndex
		let outstanding = false
		for (let index = 0; ending !== undefined && index < ending; index += 1) {
			if (!turn.released.has(index)) {
				outstanding = true
				break
			}
		}
		turn.pool.setUnfinishedEarlierWork(outstanding)
	}
}
