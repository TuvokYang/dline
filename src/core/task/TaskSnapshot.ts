import type { ClineAsk } from "@shared/ExtensionMessage"
import cloneDeep from "clone-deep"
import type { BlockLifecycle } from "./BlockPhaseMachine"
// The enum is needed as a value here to classify hydrated block phases; the
// type-only re-export from TaskController cannot be used for that.
import { BlockPhase as BlockPhaseValue } from "./BlockPhaseMachine"
import type { QueuedInputEntry } from "./input-queue/InputQueue"
import type { ActiveInteraction } from "./interaction/InteractionReducer"
import type { NewTaskConsumedState } from "./new-task/new-task-handoff"
import type {
	TaskAnchor,
	TaskCancellationState,
	TaskCompletionState,
	TaskOrdinaryInputAdmission,
	TaskRuntimeError,
	TaskRuntimeState,
	TurnState,
} from "./runtime/TaskRuntimeState"
import type { BlockPhase } from "./TaskController"
import { TaskPhase } from "./TaskPhase"

/**
 * Type guard that validates an apiIndex is a non-negative integer
 * within the bounds of the apiConversationHistory array.
 * Exported as a shared utility so both Task (index.ts) and
 * ResumeHandler can validate snapshot apiIndex fields consistently.
 */
export function isValidApiIndex(index: unknown, historyLength: number): index is number {
	return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < historyLength
}

/**
 * Awaiting kinds classify what the task is waiting for.
 */
export type TaskSnapshotAwaitingKind = "none" | "conversation" | "approval" | "resume" | "completion" | "error_recovery"

/**
 * Awaiting context stored in a TaskSnapshot to classify waiting states.
 */
export interface TaskSnapshotAwaiting {
	kind: TaskSnapshotAwaitingKind
	taskAsk?: ClineAsk
	activeFunctionId?: string
	/** Canonical Dline trace identity for the active block. */
	activeDlineTid?: string
	messageTs?: number
}

/**
 * Block status reason tracks why a block is in its current phase.
 */
export type TaskSnapshotBlockStatusReason =
	| "ready"
	| "auto_approved"
	| "awaiting_user"
	| "user_approved"
	| "user_rejected"
	| "cascade_skipped"
	| "user_cancelled"
	| "completed"
	| "restored"

/**
 * Approval context stored in a TaskSnapshot when phase is AWAITING_APPROVAL.
 */
export interface TaskSnapshotApproval {
	mode: "serial" | "parallel"
	blocks: Array<{
		functionId: string
		/** Canonical Dline trace identity for this lifecycle block. */
		dlineTid?: string
		name: string
		phase: BlockPhase
		/** Index of this block's tool_use in apiConversationHistory */
		apiIndex: number
		askType?: ClineAsk
		requiresApproval?: boolean
		ts?: number
		statusReason?: TaskSnapshotBlockStatusReason
	}>
	activeFunctionId?: string
	/** Canonical Dline trace identity for the active approval block. */
	activeDlineTid?: string
}

/**
 * Execution context stored in a TaskSnapshot when phase is EXECUTING.
 */
export interface TaskSnapshotExecution {
	mode: "serial" | "parallel"
	/** Canonical function identities of currently executing tools. */
	executingFunctionIds: string[]
	/** Canonical Dline trace identities of currently executing tools. */
	executingDlineTids?: string[]
}

/**
 * Resume context stored in a TaskSnapshot when phase is RESUMING.
 */
export interface TaskSnapshotResume {
	/** Index of the assistant message with pending tools in apiConversationHistory */
	assistantApiIndex: number
	pendingFunctionIds: string[]
	answeredFunctionIds: string[]
}

/**
 * Cancel context stored in a TaskSnapshot when phase is CANCELLING.
 */
export interface TaskSnapshotCancel {
	source: "user" | "hook" | "abort"
	fromPhase: TaskPhase
}

/**
 * Error recovery kind classifies the type of error awaiting user action.
 */
export type TaskSnapshotErrorKind = "api_req_failed" | "mistake_limit_reached"

/**
 * Error recovery action types available to user.
 */
export type TaskSnapshotErrorAction = "retry" | "process_anyway" | "start_new_task"

/**
 * Error recovery context stored in a TaskSnapshot when awaiting error recovery.
 */
export interface TaskSnapshotErrorRecovery {
	kind: TaskSnapshotErrorKind
	sourceAsk: ClineAsk
	message: string
	actions: TaskSnapshotErrorAction[]
	messageTs?: number
	retryable: boolean
	processAllowed: boolean
}

/**
 * State snapshot persisted as a state_snapshot message in ui_messages.jsonl.
 *
 * On resume, the latest snapshot is read to determine the exact recovery action
 * without re-inferring state from message history. The apiIndex field links
 * directly into apiConversationHistory for fromHistory replay.
 */
interface LegacyTaskProfileInvalidState {
	profileId?: string
	displayName?: string
	reason: "missing" | "disabled" | "credential_unavailable" | "configuration_invalid"
	message: string
}

export interface TaskSnapshot {
	phase: TaskPhase
	/** Last index in apiConversationHistory that this snapshot corresponds to */
	apiIndex: number
	timestamp: number
	version?: 2
	taskId?: string
	revision?: number
	anchor?: TaskAnchor
	turn?: TurnState
	interaction?: ActiveInteraction
	/** Explicit ordinary input admission retained across restart recovery. */
	ordinaryInput?: TaskOrdinaryInputAdmission
	interruptedInteraction?: ActiveInteraction
	cancellation?: TaskCancellationState
	runtimeError?: TaskRuntimeError
	completion?: TaskCompletionState
	/** Legacy field accepted for backward compatibility and ignored during hydration. */
	profileInvalid?: LegacyTaskProfileInvalidState
	/** Canonical New Task identity consumed before this historical Task exited. */
	newTaskConsumed?: NewTaskConsumedState
	awaiting?: TaskSnapshotAwaiting
	approval?: TaskSnapshotApproval
	execution?: TaskSnapshotExecution
	resume?: TaskSnapshotResume
	cancel?: TaskSnapshotCancel
	error?: TaskSnapshotErrorRecovery
	/** Retained user input awaiting delivery; survives cancel, pause and reload. */
	inputQueue?: QueuedInputEntry[]
}

type LegacySnapshotSection = Record<string, unknown>
type LegacyApprovalBlock = LegacySnapshotSection & { functionId?: string; callId?: string }
type LegacySnapshotRecord = Record<string, unknown> & {
	awaiting?: LegacySnapshotSection & { activeFunctionId?: string; activeCallId?: string }
	approval?: LegacySnapshotSection & {
		blocks?: LegacyApprovalBlock[]
		activeFunctionId?: string
		activeCallId?: string
	}
	execution?: LegacySnapshotSection & { executingFunctionIds?: string[]; executing?: string[] }
	resume?: LegacySnapshotSection & {
		pendingFunctionIds?: string[]
		pendingToolUseIds?: string[]
		answeredFunctionIds?: string[]
		answeredToolUseIds?: string[]
	}
}

/** Normalize pre-canonical snapshot identity names at the persistence ingress boundary. */
export function normalizeLegacyTaskSnapshot(input: unknown): TaskSnapshot {
	const raw = input as LegacySnapshotRecord
	const awaiting = raw.awaiting
		? {
				...raw.awaiting,
				activeFunctionId: raw.awaiting.activeFunctionId ?? raw.awaiting.activeCallId,
				activeCallId: undefined,
			}
		: undefined
	const approval = raw.approval
		? {
				...raw.approval,
				blocks: (raw.approval.blocks ?? []).map((block) => ({
					...block,
					functionId: block.functionId ?? block.callId,
					callId: undefined,
				})),
				activeFunctionId: raw.approval.activeFunctionId ?? raw.approval.activeCallId,
				activeCallId: undefined,
			}
		: undefined
	const execution = raw.execution
		? {
				...raw.execution,
				executingFunctionIds: raw.execution.executingFunctionIds ?? raw.execution.executing ?? [],
				executing: undefined,
			}
		: undefined
	const resume = raw.resume
		? {
				...raw.resume,
				pendingFunctionIds: raw.resume.pendingFunctionIds ?? raw.resume.pendingToolUseIds ?? [],
				answeredFunctionIds: raw.resume.answeredFunctionIds ?? raw.resume.answeredToolUseIds ?? [],
				pendingToolUseIds: undefined,
				answeredToolUseIds: undefined,
			}
		: undefined
	return { ...raw, awaiting, approval, execution, resume } as TaskSnapshot
}

/** Identity field rejected while hydrating a canonical snapshot. */
export type TaskSnapshotIdentityField = "taskId" | "turnId" | "interactionId" | "functionId" | "dlineTid"

/** Typed failure raised when a version 2 snapshot lacks canonical identity. */
export class TaskSnapshotIdentityError extends Error {
	readonly code = "invalid_snapshot_identity"

	constructor(readonly field: TaskSnapshotIdentityField) {
		super(`invalid_snapshot_identity: ${field}`)
		this.name = "TaskSnapshotIdentityError"
	}
}

/** Assert a canonical identity is present in a version 2 snapshot. */
function requireIdentity(value: string | undefined, field: TaskSnapshotIdentityField): string {
	if (!value) {
		throw new TaskSnapshotIdentityError(field)
	}
	return value
}

/** Clone one lifecycle block without sharing mutable snapshot state. */
function cloneBlock(block: BlockLifecycle): BlockLifecycle {
	return { ...block }
}

/**
 * Reconstruct approval and execution ownership for a hydrated turn.
 *
 * Every historical shape reaches this function, and each is decided explicitly
 * rather than left to fall through:
 *
 *   - ownership already present: kept as written, filtered to live blocks;
 *   - no ownership, `activeDlineTid` naming an awaiting block: the manual slot,
 *     which is what `BlockPhaseMachine.restoreTurn` requires;
 *   - no ownership, `activeDlineTid` naming an executing block: the execution
 *     set, because the block was approved before the restart and must not be
 *     presented for approval a second time;
 *   - `activeDlineTid` naming a terminal or unknown block: dropped, since a
 *     finished block owns nothing;
 *   - several executing blocks: all recorded, so a restart does not silently
 *     forget the ones the single-valued field could not name.
 */
function hydrateTurnOwnership(
	turn: TurnState,
	blocks: BlockLifecycle[],
): Pick<TurnState, "activeDlineTid" | "approval" | "executing"> {
	const terminal = new Set([
		BlockPhaseValue.COMPLETED,
		BlockPhaseValue.REJECTED,
		BlockPhaseValue.SKIPPED,
		BlockPhaseValue.CANCELLED,
	])
	const find = (dlineTid: string) => blocks.find((block) => block.dlineTid === dlineTid)
	const live = (dlineTid: string) => {
		const block = find(dlineTid)
		return block !== undefined && !terminal.has(block.phase)
	}

	const executing = (
		turn.executing ??
		blocks
			.filter((block) => block.phase === BlockPhaseValue.EXECUTING || block.phase === BlockPhaseValue.AUTO_EXECUTING)
			.map((block) => block.dlineTid)
	).filter(live)

	const automatic = (
		turn.approval?.automatic ?? executing.filter((dlineTid) => find(dlineTid)?.requiresApproval === false)
	).filter(live)

	const claimed = turn.approval?.manual?.dlineTid ?? turn.activeDlineTid
	const claimedPhase = claimed ? find(claimed)?.phase : undefined
	// A slot survives a restart in either of its two stages: a block still
	// awaiting the first approval, or an already-executing block holding the
	// slot for a question it raised mid-flight. Accepting only the awaiting
	// phase would drop a live in-flight owner and let a second prompt be
	// admitted while the first is still outstanding.
	const heldInFlight =
		turn.approval?.manual?.stage === "in_flight" &&
		(claimedPhase === BlockPhaseValue.EXECUTING || claimedPhase === BlockPhaseValue.AUTO_EXECUTING)
	const owner =
		claimed && live(claimed) && (claimedPhase === BlockPhaseValue.AWAITING_APPROVAL || heldInFlight)
			? { dlineTid: claimed, stage: heldInFlight ? ("in_flight" as const) : ("admission" as const) }
			: undefined

	return {
		activeDlineTid: owner?.dlineTid,
		approval: { manual: owner, automatic: automatic.filter((dlineTid) => dlineTid !== owner?.dlineTid) },
		executing,
	}
}

/** Clone canonical turn state and validate every identity. */
function cloneTurn(turn: TurnState): TurnState {
	const turnId = requireIdentity(turn.turnId, "turnId")
	const blocks = turn.blocks.map((block) => ({ ...cloneBlock(block), dlineTid: requireIdentity(block.dlineTid, "dlineTid") }))
	if (turn.activeDlineTid) {
		requireIdentity(turn.activeDlineTid, "dlineTid")
	}
	return { ...turn, turnId, blocks, ...hydrateTurnOwnership(turn, blocks) }
}

/** Clone one consumed New Task identity without retaining successor payload. */
function cloneNewTaskConsumed(consumed: NewTaskConsumedState): NewTaskConsumedState {
	return {
		functionId: requireIdentity(consumed.functionId, "functionId"),
		dlineTid: requireIdentity(consumed.dlineTid, "dlineTid"),
	}
}

/** Clone one active interaction and validate its causal identity. */
function cloneInteraction(interaction: ActiveInteraction): ActiveInteraction {
	const taskId = requireIdentity(interaction.taskId, "taskId")
	const turnId = requireIdentity(interaction.turnId, "turnId")
	const interactionId = requireIdentity(interaction.interactionId, "interactionId")
	const acceptedResponse = interaction.acceptedResponse
		? {
				...interaction.acceptedResponse,
				taskId: requireIdentity(interaction.acceptedResponse.taskId, "taskId"),
				turnId: requireIdentity(interaction.acceptedResponse.turnId, "turnId"),
				interactionId: requireIdentity(interaction.acceptedResponse.interactionId, "interactionId"),
				...(interaction.acceptedResponse.draft
					? {
							draft: {
								...interaction.acceptedResponse.draft,
								images: [...interaction.acceptedResponse.draft.images],
								files: [...interaction.acceptedResponse.draft.files],
							},
						}
					: {}),
				...(interaction.acceptedResponse.selection
					? { selection: { values: [...interaction.acceptedResponse.selection.values] } }
					: {}),
			}
		: undefined
	if (interaction.status === "resolving" && !acceptedResponse) {
		throw new Error("invalid_resolving_interaction")
	}
	if (
		acceptedResponse &&
		(acceptedResponse.taskId !== taskId ||
			acceptedResponse.turnId !== turnId ||
			acceptedResponse.interactionId !== interactionId)
	) {
		throw new Error("invalid_resolving_interaction_identity")
	}
	return {
		...interaction,
		taskId,
		turnId,
		interactionId,
		...(interaction.retryContent ? { retryContent: cloneDeep(interaction.retryContent) } : {}),
		...(interaction.anchor ? { anchor: { ...interaction.anchor } } : {}),
		...(acceptedResponse ? { acceptedResponse } : {}),
	}
}

/** Clone and validate one explicit ordinary-input admission from persisted state. */
function cloneOrdinaryInputAdmission(admission: TaskOrdinaryInputAdmission): TaskOrdinaryInputAdmission {
	if ((admission as { kind?: unknown }).kind !== "profile_recovery") {
		throw new Error("invalid_ordinary_input_admission")
	}
	return { kind: "profile_recovery" }
}

/** Convert runtime state into a complete version 2 persistence snapshot. */
export function createSnapshot(state: Readonly<TaskRuntimeState>, timestamp = Date.now()): TaskSnapshot {
	return {
		version: 2,
		taskId: requireIdentity(state.taskId, "taskId"),
		phase: state.phase,
		apiIndex: state.anchor.apiIndex,
		timestamp,
		revision: state.revision,
		anchor: { ...state.anchor },
		turn: state.turn ? cloneTurn(state.turn) : undefined,
		interaction: state.interaction ? cloneInteraction(state.interaction) : undefined,
		ordinaryInput: state.ordinaryInput ? cloneOrdinaryInputAdmission(state.ordinaryInput) : undefined,
		interruptedInteraction: state.interruptedInteraction ? cloneInteraction(state.interruptedInteraction) : undefined,
		cancellation: state.cancellation ? { ...state.cancellation } : undefined,
		runtimeError: state.error ? { ...state.error } : undefined,
		completion: state.completion ? { ...state.completion } : undefined,
		newTaskConsumed: state.newTaskConsumed ? cloneNewTaskConsumed(state.newTaskConsumed) : undefined,
	}
}

/** Hydrate a complete runtime aggregate from a strict version 2 snapshot. */
export function hydrateSnapshot(snapshot: TaskSnapshot): TaskRuntimeState {
	if (snapshot.version !== 2 || snapshot.revision === undefined || !snapshot.anchor) {
		throw new Error("invalid_snapshot_version")
	}
	const taskId = requireIdentity(snapshot.taskId, "taskId")
	const turn = snapshot.turn ? cloneTurn(snapshot.turn) : undefined
	const interaction = snapshot.interaction ? cloneInteraction(snapshot.interaction) : undefined
	const ordinaryInput = snapshot.ordinaryInput ? cloneOrdinaryInputAdmission(snapshot.ordinaryInput) : undefined
	if (ordinaryInput && (snapshot.phase !== TaskPhase.BETWEEN_TURNS || interaction)) {
		throw new Error("invalid_ordinary_input_admission")
	}
	const interruptedInteraction = snapshot.interruptedInteraction ? cloneInteraction(snapshot.interruptedInteraction) : undefined
	if (snapshot.anchor.turnId) {
		requireIdentity(snapshot.anchor.turnId, "turnId")
	}
	if (snapshot.anchor.interactionId) {
		requireIdentity(snapshot.anchor.interactionId, "interactionId")
	}
	return {
		taskId,
		phase: snapshot.phase,
		revision: snapshot.revision,
		anchor: { ...snapshot.anchor },
		turn,
		interaction,
		ordinaryInput,
		interruptedInteraction,
		cancellation: snapshot.cancellation ? { ...snapshot.cancellation } : undefined,
		error: snapshot.runtimeError ? { ...snapshot.runtimeError } : undefined,
		completion: snapshot.completion ? { ...snapshot.completion } : undefined,
		newTaskConsumed: snapshot.newTaskConsumed ? cloneNewTaskConsumed(snapshot.newTaskConsumed) : undefined,
	}
}
