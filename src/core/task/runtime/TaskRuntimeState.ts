import type { BlockLifecycle } from "../BlockPhaseMachine"
import type { ActiveInteraction } from "../interaction/InteractionReducer"
import type { NewTaskConsumedState } from "../new-task/new-task-handoff"
import { TaskPhase } from "../TaskPhase"
import type { TaskEffectType } from "./TaskEffect"

/** Persistent anchors that locate the runtime state in UI and API history. */
export interface TaskAnchor {
	apiIndex: number
	uiMessageTs?: number
	turnId?: string
	interactionId?: string
}

/** Source and origin phase for an in-progress cancellation. */
export interface TaskCancellationState {
	source: CancelSource
	fromPhase: TaskPhase
}

/** Runtime diagnostic produced by a failed effect. */
export interface TaskRuntimeError {
	effectId: string
	effectType: TaskEffectType
	/** Revision that emitted the failed effect. */
	originRevision?: number
	message: string
}

/** Completion identity retained while completion is visible. */
export interface TaskCompletionState {
	completionId: string
}

/**
 * Which stage of its life a block holds the manual approval slot for.
 *
 * `admission` is a block asking for permission to start; `in_flight` is a block
 * that is already executing and has asked a question of its own. Only the first
 * is mutually exclusive with membership in the execution set, so the two cases
 * cannot be collapsed without either forbidding mid-execution prompts or
 * allowing a block to execute before it was admitted.
 */
export type ManualApprovalStage = "admission" | "in_flight"

/** The single serial manual approval slot. */
export interface ManualApprovalOwner {
	dlineTid: string
	stage: ManualApprovalStage
}

/**
 * Approval ownership for one turn, held separately from execution ownership.
 *
 * Approval and execution were previously the same field, so a manually approved
 * block kept the approval slot for the whole of its execution and no later
 * block could be presented until it finished. Separating them is what lets the
 * slot be released at the moment approval is granted.
 */
export interface TurnApprovalState {
	/**
	 * Held by at most one block, because a user can only answer one question at
	 * a time. This is the serial guarantee.
	 */
	manual?: ManualApprovalOwner
	/**
	 * Blocks approved by policy rather than by the user.
	 *
	 * Keyed per block and never occupying the serial slot, so any number may
	 * resolve at once without contending for the single user-facing interaction.
	 *
	 * The policy version that granted each approval is deliberately not stored
	 * here. The reducer has no access to the permission state, so a version kept
	 * alongside this set could never be compared against anything; the granting
	 * version belongs to the preflight admission record, which is re-checked
	 * before the side-effect closure starts. A revoked block re-enters the
	 * approval stage through the ordinary approval-required transition.
	 */
	automatic: string[]
}

/** Canonical state for one assistant turn and its tool blocks. */
export interface TurnState {
	turnId: string
	assistantApiIndex: number
	blocks: BlockLifecycle[]
	/**
	 * Read-only projection of the manual approval owner.
	 *
	 * Retained because `BlockPhaseMachine`, `ResumeReconciler` and the snapshot
	 * schema all read it as the sole awaiting-approval identity. The reducer
	 * rewrites it from `approval.manual` on every committed turn transition, so
	 * it is never the authority and must not be assigned on its own.
	 */
	activeDlineTid?: string
	mode: "serial" | "parallel"
	/**
	 * Optional because states restored from a legacy snapshot, and turns built
	 * by callers outside this module, carry only `activeDlineTid`. The reducer
	 * derives both fields before use and writes them back on every accepted
	 * transition, so a reduced state always carries them.
	 */
	approval?: TurnApprovalState
	/**
	 * Blocks that have been admitted and are executing.
	 *
	 * A block enters at the moment its approval is granted and leaves when it
	 * reaches a terminal phase, so admission is never inferred from a phase
	 * value that two different lifecycles can both produce.
	 */
	executing?: string[]
}

/** One explicitly admitted ordinary input surface without an active interaction. */
export interface TaskOrdinaryInputAdmission {
	kind: "profile_recovery"
}

/** Aggregate runtime state used by the pure task reducer. */
export interface TaskRuntimeState {
	taskId: string
	phase: TaskPhase
	revision: number
	anchor: TaskAnchor
	turn?: TurnState
	interaction?: ActiveInteraction
	/** Explicit exception that allows one ordinary reply while the task loop waits. */
	ordinaryInput?: TaskOrdinaryInputAdmission
	/** Awaiting primary interaction temporarily hidden by one interrupting interaction. */
	interruptedInteraction?: ActiveInteraction
	cancellation?: TaskCancellationState
	error?: TaskRuntimeError
	completion?: TaskCompletionState
	/** Canonical New Task identity already consumed before this Task exited. */
	newTaskConsumed?: NewTaskConsumedState
	/** Highest effect-origin revision invalidated by a cancellation transaction. */
	supersededEffectRevision?: number
}

/** Supported sources for task cancellation. */
export type CancelSource = "user" | "hook" | "system"

/** Parameters used to construct a task runtime aggregate. */
export interface CreateTaskRuntimeStateOptions {
	taskId: string
	phase?: TaskPhase
	revision?: number
	anchor?: TaskAnchor
}

/** Create a normalized task runtime aggregate. */
export function createTaskRuntimeState(options: CreateTaskRuntimeStateOptions): TaskRuntimeState {
	return {
		taskId: options.taskId,
		phase: options.phase ?? TaskPhase.IDLE,
		revision: options.revision ?? 0,
		anchor: options.anchor ?? { apiIndex: -1 },
	}
}
