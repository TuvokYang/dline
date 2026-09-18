import type { ToolUse } from "@core/assistant-message"
import { resolveMaxParallelToolCalls } from "@shared/concurrency-limits"
import { isTurnEndingToolName } from "../../assistant-message-order"
import type { BlockLifecycleOutcome, TurnDriverSchedulerPort, TurnDriverSchedulingSession } from "./TurnDriverPort"
import { TurnExecutionPool } from "./TurnExecutionPool"

export interface TurnToolSchedulerOptions {
	readConfiguredLimit(): number | undefined
	isParallelToolCallingEnabled(): boolean
	onBlockCancelled?(dlineTid: string): Promise<void>
	onBlockSkipped?(dlineTid: string): Promise<void>
}

/** Resolve the pool ceiling from current settings on every admission decision. */
export function getToolConcurrencyLimit(configured: number | undefined, parallelEnabled: boolean): number {
	return resolveMaxParallelToolCalls(configured, parallelEnabled)
}

/** Owns the per-turn pool, lane assignment and concurrency admission policy. */
export class TurnToolScheduler implements TurnDriverSchedulerPort {
	private activePool?: TurnExecutionPool<BlockLifecycleOutcome>

	constructor(private readonly options: TurnToolSchedulerOptions) {}

	cancelActiveTurn(): void {
		this.activePool?.cancelAll()
	}

	notifyLimitChanged(): void {
		this.activePool?.notifyLimitChanged()
	}

	async runTurn(
		toolUses: ToolUse[],
		run: (session: TurnDriverSchedulingSession) => Promise<BlockLifecycleOutcome>,
	): Promise<BlockLifecycleOutcome> {
		const pool = new TurnExecutionPool<BlockLifecycleOutcome>({
			limit: () => getToolConcurrencyLimit(this.options.readConfiguredLimit(), this.options.isParallelToolCallingEnabled()),
			name: "turn-tool-pool",
		})
		const unresolvedAdmissions = toolUses.map(() => true)
		const firstTurnEndingIndex = toolUses.findIndex((tool) => isTurnEndingToolName(tool.name))
		const updateTurnEndingFence = () => {
			pool.setUnfinishedEarlierWork(
				firstTurnEndingIndex >= 0 && unresolvedAdmissions.slice(0, firstTurnEndingIndex).some(Boolean),
			)
		}
		updateTurnEndingFence()
		const session: TurnDriverSchedulingSession = {
			markAdmissionSettled: (index) => {
				unresolvedAdmissions[index] = false
				updateTurnEndingFence()
			},
			markAdmissionUnsettled: (index) => {
				unresolvedAdmissions[index] = true
				updateTurnEndingFence()
			},
			submit: async (tool, index, admission, runBlock) => {
				const dlineTid = tool.dline_tid ?? `unkeyed-${index}`
				const pendingOutcome = pool.submit({
					dlineTid,
					index,
					lanes: admission.lanes,
					isTurnEnding: isTurnEndingToolName(tool.name),
					run: async (signal) => {
						if (signal.aborted) return "halt_turn"
						const value = await runBlock(signal)
						if (value === "retry_admission") session.markAdmissionUnsettled(index)
						if (value === "halt_turn") pool.cancelBlocksAfter(index)
						return value
					},
				})
				unresolvedAdmissions[index] = false
				updateTurnEndingFence()
				const outcome = await pendingOutcome
				if (outcome.error !== undefined) {
					pool.cancelBlocksAfter(index)
					throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error))
				}
				if (outcome.skipped) await this.options.onBlockSkipped?.(outcome.dlineTid)
				if (outcome.cancelled) {
					await this.options.onBlockCancelled?.(outcome.dlineTid)
					return "halt_turn"
				}
				return outcome.value ?? "completed"
			},
		}
		this.activePool = pool
		try {
			return await run(session)
		} finally {
			if (this.activePool === pool) this.activePool = undefined
		}
	}
}
