import { BoundedGate, type GatePermit } from "@core/task/runtime/concurrency/BoundedGate"
import { MIN_PARALLEL_EXECUTIONS, resolveMaxParallelSubagents } from "@shared/concurrency-limits"
import type { TaskConfig } from "../types/TaskConfig"

/**
 * How deep subagent fan-out may nest.
 *
 * A subagent may itself call the fan-out tool, so without a declared ceiling
 * the tree can grow until the shared budget is held entirely by parents waiting
 * on children. Depth is bounded separately from width because the two failures
 * differ: excess width queues and eventually runs, whereas excess depth holds
 * budget with work that cannot progress on its own.
 */
export const MAX_SUBAGENT_NESTING_DEPTH = 3

/** A held unit of the task-scoped subagent budget. */
export interface SubagentSlot {
	/**
	 * Return the slot.
	 *
	 * Call this only once the subagent work has actually stopped. A runner that
	 * was interrupted while a tool was still executing has returned but has not
	 * stopped, so releasing on the runner's return would report capacity the
	 * machine does not have.
	 *
	 * Repeated calls are ignored, so a caller may release defensively.
	 */
	release(): void
}

/** Why an acquisition was refused outright rather than queued. */
export type SubagentAdmissionRefusal = "depth_exceeded"

/** Outcome of requesting a slot. */
export type SubagentAdmission =
	| { readonly admitted: true; readonly slot: SubagentSlot }
	| { readonly admitted: false; readonly reason: SubagentAdmissionRefusal; readonly message: string }

/** Observable budget state, used by status projection and tests. */
export interface SubagentBudgetState {
	/** Slots currently held across the whole task. */
	running: number
	/** Requests waiting for a slot across the whole task. */
	queued: number
	/** Limit in force for the next admission decision. */
	limit: number
	/** Nesting depth of this view; the task's own fan-out is 0. */
	depth: number
}

/** Construction options for the task-scoped budget root. */
export interface SubagentFanoutBudgetOptions {
	/** Current subagent limit, read on every admission decision. */
	limit: number | (() => number)
	/** Maximum nesting depth; overridable so tests can use a shallower tree. */
	maxDepth?: number
}

/**
 * The task-scoped budget for concurrently executing subagents.
 *
 * One gate is created per task and shared by every fan-out within it, including
 * nested ones. A child view does not receive a fresh allowance: it borrows from
 * the same gate at a greater depth, which is what keeps a tree of fan-outs
 * bounded by a single user-visible setting rather than by `limit ** depth`.
 *
 * The budget is deliberately separate from the tool execution pool. Subagent
 * width saturates provider capacity while tool width saturates local editor and
 * process resources, so throttling one must not throttle the other.
 */
export class SubagentFanoutBudget {
	private readonly gate: BoundedGate
	private readonly maxDepth: number

	/**
	 * The slot held by the subagent that owns this view, when it is nested.
	 *
	 * A parent blocked on its children is not itself running subagent work.
	 * Keeping its slot held would let a nested fan-out deadlock against its own
	 * parent once the tree is as wide as the limit, so the parent's slot is
	 * surrendered for exactly as long as it waits.
	 */
	private readonly parentSlot: SubagentSlot | undefined

	/** Nesting depth of this view; the task's own fan-out is 0. */
	readonly depth: number

	constructor(options: SubagentFanoutBudgetOptions)
	constructor(gate: BoundedGate, depth: number, maxDepth: number, parentSlot?: SubagentSlot)
	constructor(
		optionsOrGate: SubagentFanoutBudgetOptions | BoundedGate,
		depth = 0,
		maxDepth = MAX_SUBAGENT_NESTING_DEPTH,
		parentSlot?: SubagentSlot,
	) {
		if (optionsOrGate instanceof BoundedGate) {
			this.gate = optionsOrGate
			this.depth = depth
			this.maxDepth = maxDepth
			this.parentSlot = parentSlot
			return
		}
		this.gate = new BoundedGate({ limit: optionsOrGate.limit, name: "subagent-fanout" })
		this.depth = 0
		this.maxDepth = optionsOrGate.maxDepth ?? MAX_SUBAGENT_NESTING_DEPTH
		this.parentSlot = undefined
	}

	/** Current budget state for status projection. */
	state(): SubagentBudgetState {
		return { ...this.gate.state, depth: this.depth }
	}

	/** Whether a fan-out started from this view stays within the depth ceiling. */
	canNest(): boolean {
		return this.depth < this.maxDepth
	}

	/**
	 * Create the view a subagent's own fan-out draws on.
	 *
	 * @param ownSlot The slot held by that subagent, so it can be surrendered
	 *   while the subagent waits on its children.
	 * @returns A view over the same budget, one level deeper.
	 */
	child(ownSlot?: SubagentSlot): SubagentFanoutBudget {
		return new SubagentFanoutBudget(this.gate, this.depth + 1, this.maxDepth, ownSlot)
	}

	/**
	 * Take one slot, waiting when the budget is saturated.
	 *
	 * Depth is checked before queueing: an over-deep request must fail fast with
	 * something the model can act on, because waiting would not make it
	 * admissible.
	 *
	 * @param signal Optional signal that abandons the wait.
	 * @returns The slot, or the reason it was refused outright.
	 */
	async acquire(signal?: AbortSignal): Promise<SubagentAdmission> {
		if (!this.canNest()) {
			return {
				admitted: false,
				reason: "depth_exceeded",
				message: `Subagent nesting depth limit reached (${this.maxDepth}). Do this work directly instead of delegating it further.`,
			}
		}
		const permit = await this.gate.acquire(signal)
		return { admitted: true, slot: toSlot(permit) }
	}

	/**
	 * Await a fan-out without holding the owning subagent's slot.
	 *
	 * At the task's own depth there is no owning slot and this is a plain await.
	 * One level down it is what prevents a parent from occupying capacity its
	 * own children need in order to finish.
	 *
	 * The parent does not reclaim a slot here. It resumes inside the runner
	 * that owns its lifecycle, which re-acquires before continuing; reclaiming
	 * eagerly would make the parent compete with its own siblings for a slot it
	 * is not yet ready to use.
	 *
	 * @param work The fan-out to await.
	 * @returns The result of `work`.
	 */
	async awaitChildren<T>(work: () => Promise<T>): Promise<T> {
		this.parentSlot?.release()
		return await work()
	}

	/**
	 * Withhold capacity for work that escaped its slot.
	 *
	 * A tool abandoned by an interrupted run can outlive the run itself. Its
	 * slot has to come back or the rest of the batch never starts, but the
	 * resources are still in use, so the allowance shrinks by one for exactly
	 * as long as that work runs. Without this the slot would be handed to a
	 * replacement while the original tool is still holding a terminal or a
	 * host request, and reported capacity would exceed the real one.
	 *
	 * @param until Settles when the escaped work finally stops.
	 */
	withholdCapacity(until: Promise<unknown>): void {
		this.gate.withholdCapacity(until)
	}

	/** Change notification for a limit that is read from settings. */
	notifyLimitChanged(): void {
		this.gate.notifyLimitChanged()
	}
}

/**
 * Wrap a gate permit as a slot.
 * @param permit Underlying gate permit.
 * @returns A slot whose release is idempotent.
 */
function toSlot(permit: GatePermit): SubagentSlot {
	return { release: () => permit.release() }
}

/**
 * Resolve the effective concurrent-subagent limit for a task.
 *
 * Kept here so callers holding only a settings value do not each repeat the
 * floor. The shared clamp already rejects zero; this guards a computed value
 * passed straight through.
 *
 * @param configured Resolved setting value.
 * @returns A limit of at least one.
 */
export function usableSubagentLimit(configured: number): number {
	return Number.isFinite(configured) && configured >= MIN_PARALLEL_EXECUTIONS ? Math.trunc(configured) : MIN_PARALLEL_EXECUTIONS
}

/**
 * Get or create the task-scoped subagent budget.
 *
 * One budget per task is what makes the setting mean "subagents at once in this
 * task" rather than "per fan-out call". The limit is read through a function so
 * a change to the setting reaches queued work without recreating the budget.
 *
 * @param config Current task config.
 * @returns The task's budget root.
 */
export function getSubagentFanoutBudget(config: TaskConfig): SubagentFanoutBudget {
	config.subagentFanoutBudget ??= new SubagentFanoutBudget({
		limit: () =>
			usableSubagentLimit(
				resolveMaxParallelSubagents(config.services.stateManager.getGlobalSettingsKey("maxParallelSubagents")),
			),
	})
	return config.subagentFanoutBudget
}
