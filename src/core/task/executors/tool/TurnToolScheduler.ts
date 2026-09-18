import type { ToolUse } from "@core/assistant-message"
import { resolveMaxParallelToolCalls } from "@shared/concurrency-limits"
import { isTurnEndingToolName } from "../../assistant-message-order"
import type { TurnState } from "../../runtime/TaskRuntimeState"
import type { ToolPreflightAdmission, ToolPreflightResult } from "./ToolPreflight"
import type { BlockLifecycleOutcome, TurnDriverSchedulerPort } from "./TurnDriverPort"
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

	canRunConcurrently(
		turn: TurnState,
		toolUses: readonly ToolUse[],
		admissions: ReadonlyMap<string, ToolPreflightResult<void>>,
	): boolean {
		return (
			turn.mode === "parallel" &&
			toolUses.length > 1 &&
			toolUses.every((tool) => {
				const admission = tool.dline_tid ? admissions.get(tool.dline_tid) : undefined
				return (
					admission?.outcome === "admitted" &&
					(admission.decision.kind === "none" || admission.decision.kind === "automatic")
				)
			})
		)
	}

	async runThroughPool(
		toolUses: ToolUse[],
		admissions: ReadonlyMap<string, ToolPreflightResult<void>>,
		runBlockLifecycle: (tool: ToolUse) => Promise<BlockLifecycleOutcome>,
	): Promise<BlockLifecycleOutcome> {
		const pool = new TurnExecutionPool<BlockLifecycleOutcome>({
			limit: () =>
				getToolConcurrencyLimit(
					this.options.readConfiguredLimit(),
					this.options.isParallelToolCallingEnabled(),
				),
			name: "turn-tool-pool",
		})
		const identityOf = (tool: ToolUse, index: number): string => tool.dline_tid ?? `unkeyed-${index}`
		const admissionFor = (tool: ToolUse, index: number): ToolPreflightAdmission<void> => {
			const dlineTid = identityOf(tool, index)
			const admission = admissions.get(dlineTid)
			if (admission?.outcome !== "admitted") {
				throw new Error(`Pool scheduling requires an admitted block: dlineTid=${dlineTid}`)
			}
			return admission
		}
		this.activePool = pool
		try {
			const outcomes = await Promise.all(
				toolUses.map((tool, index) =>
					pool
						.submit({
							dlineTid: identityOf(tool, index),
							index,
							lanes: admissionFor(tool, index).lanes,
							isTurnEnding: isTurnEndingToolName(tool.name),
							run: async (signal) => {
								if (signal.aborted) return "halt_turn"
								const outcome = await runBlockLifecycle(tool)
								if (outcome === "halt_turn") pool.cancelBlocksAfter(index)
								return outcome
							},
						})
						.then(async (outcome) => {
							if (outcome.error !== undefined) pool.cancelBlocksAfter(index)
							// Terminal pool state is durable before the turn-ending or
							// cancelled sibling settles, closing the restart window where a
							// private pool outcome could otherwise be replayed as live work.
							if (outcome.skipped) await this.options.onBlockSkipped?.(outcome.dlineTid)
							if (outcome.cancelled) await this.options.onBlockCancelled?.(outcome.dlineTid)
							return outcome
						}),
				),
			)

			let retryAdmission = false
			let haltTurn = false
			let firstError: unknown
			for (const outcome of outcomes) {
				if (outcome.skipped) continue
				if (outcome.cancelled) {
					haltTurn = true
					continue
				}
				if (outcome.error !== undefined) {
					firstError ??= outcome.error
					continue
				}
				if (outcome.value === "halt_turn") haltTurn = true
				if (outcome.value === "retry_admission") retryAdmission = true
			}
			if (firstError !== undefined) {
				throw firstError instanceof Error ? firstError : new Error(String(firstError))
			}
			if (haltTurn) return "halt_turn"
			return retryAdmission ? "retry_admission" : "completed"
		} finally {
			if (this.activePool === pool) this.activePool = undefined
		}
	}
}
