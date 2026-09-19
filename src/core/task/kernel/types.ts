export type TaskId = string
export type TurnId = string
export type BlockId = string
export type InteractionId = string
export type AttemptId = string
export type HaltId = string
export type EntryId = string
export type CommandId = string

export type FlowPhase = "idle" | "initializing" | "running" | "waiting" | "paused" | "completed" | "error" | "terminated"
export type BlockPhase =
	| "pending"
	| "awaiting_approval"
	| "ready"
	| "executing"
	| "completed"
	| "failed"
	| "rejected"
	| "skipped"
	| "cancelled"
export type ParticipantId =
	| "provider"
	| "tool"
	| "dialog"
	| "compose"
	| "compaction"
	| "policy"
	| "background"
	| "cotask"
	| "spawn"

export interface FlowState {
	readonly phase: FlowPhase
	readonly error?: string
	readonly completionId?: string
}

export interface KernelBlock {
	readonly blockId: BlockId
	readonly index: number
	readonly phase: BlockPhase
	readonly attempt: AttemptId
	readonly lanes: readonly string[]
	readonly turnEnding: boolean
}

export interface TurnSlice {
	readonly turnId?: TurnId
	readonly mode: "serial" | "parallel"
	readonly blocks: readonly KernelBlock[]
	readonly manualApprovalBlockId?: BlockId
	readonly automaticApprovalBlockIds: readonly BlockId[]
	readonly executingBlockIds: readonly BlockId[]
}

export interface DialogInteraction {
	readonly interactionId: InteractionId
	readonly kind: string
	readonly status: "planned" | "prepared" | "presented" | "responded"
	readonly journalRef?: string
	readonly receiverGeneration?: number
	readonly blockId?: BlockId
	readonly payloadRef?: string
	readonly actionId?: string
}

export interface DialogSlice {
	readonly primary?: DialogInteraction
	readonly approvalsByBlock: Readonly<Record<BlockId, DialogInteraction>>
	readonly interrupted?: DialogInteraction
}

export interface IntakeEntry {
	readonly entryId: EntryId
	readonly payloadRef: string
	readonly state: "accepted" | "reserved" | "included" | "consumed" | "released" | "uncertain"
	readonly journalWatermark?: { readonly epoch: number; readonly seq: number }
}

export interface IntakeSlice {
	readonly queued: readonly IntakeEntry[]
	readonly background: readonly IntakeEntry[]
	readonly coTask: readonly IntakeEntry[]
}

export type HaltSlice =
	| { readonly status: "idle"; readonly generation: number }
	| {
			readonly status: "stopping"
			readonly generation: number
			readonly haltId: HaltId
			readonly target: "paused" | "terminated"
			readonly pending: readonly ParticipantId[]
			readonly halted: readonly ParticipantId[]
			readonly failed: readonly ParticipantId[]
			readonly timedOut: readonly ParticipantId[]
	  }

export interface TaskState {
	readonly taskId: TaskId
	readonly revision: number
	readonly generation: number
	readonly flow: FlowState
	readonly turn: TurnSlice
	readonly dialog: DialogSlice
	readonly intake: IntakeSlice
	readonly halt: HaltSlice
}

interface EventBase {
	readonly generation: number
	readonly attempt?: AttemptId
}

export type UserEvent =
	| (EventBase & { readonly type: "user.submit"; readonly entryId: EntryId; readonly payloadRef: string })
	| (EventBase & { readonly type: "user.cancel"; readonly haltId: HaltId })
	| (EventBase & { readonly type: "user.terminate"; readonly haltId: HaltId })
export type ProviderEvent = EventBase & {
	readonly type: "provider.turn_ready" | "provider.failed"
	readonly turnId: TurnId
	readonly message?: string
}
export type ToolEvent = EventBase & {
	readonly type: "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled"
	readonly turnId: TurnId
	readonly blockId: BlockId
	readonly message?: string
}
export type DialogEvent =
	| (EventBase & {
			readonly type: "dialog.requested"
			readonly interactionId: InteractionId
			readonly kind: string
			readonly blockId?: BlockId
	  })
	| (EventBase & {
			readonly type: "dialog.prepared"
			readonly interactionId: InteractionId
			readonly journalRef: string
			readonly receiverGeneration: number
	  })
	| (EventBase & { readonly type: "dialog.presented"; readonly interactionId: InteractionId })
	| (EventBase & {
			readonly type: "dialog.responded"
			readonly interactionId: InteractionId
			readonly payloadRef?: string
			readonly actionId?: string
	  })
	| (EventBase & { readonly type: "dialog.resolved"; readonly interactionId: InteractionId })
export type BackgroundEvent = EventBase & {
	readonly type: "background.ready"
	readonly entryId: EntryId
	readonly payloadRef: string
}
export type ComposeEvent = EventBase & {
	readonly type: "compose.completed" | "compose.failed"
	readonly draftRef?: string
	readonly message?: string
}
export type CompactionEvent = EventBase & {
	readonly type: "compaction.started" | "compaction.completed" | "compaction.failed" | "compaction.expired"
	readonly compactionId: string
	readonly message?: string
}
export type ApprovalEvent =
	| (EventBase & {
			readonly type: "approval.requested"
			readonly turnId: TurnId
			readonly blockId: BlockId
			readonly interactionId: InteractionId
			readonly kind: string
	  })
	| (EventBase & {
			readonly type: "approval.responded"
			readonly turnId: TurnId
			readonly blockId: BlockId
			readonly interactionId: InteractionId
			readonly approved: boolean
	  })
	| (EventBase & {
			readonly type: "approval.evaluated" | "approval.failed"
			readonly blockId: BlockId
			readonly approved?: boolean
			readonly message?: string
	  })
export type CoTaskEvent = EventBase & { readonly type: "cotask.received"; readonly entryId: EntryId; readonly payloadRef: string }
export type HaltEvent = EventBase & {
	readonly type: "halt.halted" | "halt.failed"
	readonly haltId: HaltId
	readonly participantId: ParticipantId
}
export type LifecycleEvent = EventBase & {
	readonly type:
		| "lifecycle.open"
		| "lifecycle.close"
		| "lifecycle.spawned"
		| "lifecycle.spawn_failed"
		| "lifecycle.halt_timeout"
	readonly haltId?: HaltId
	readonly participantId?: ParticipantId
	readonly message?: string
}

export type TaskEvent =
	| UserEvent
	| ProviderEvent
	| ToolEvent
	| DialogEvent
	| BackgroundEvent
	| ComposeEvent
	| CompactionEvent
	| ApprovalEvent
	| CoTaskEvent
	| HaltEvent
	| LifecycleEvent

interface CommandBase {
	readonly commandId: CommandId
	readonly originRevision: number
	readonly generation: number
}

export type ProviderStartCommand = CommandBase & { readonly type: "provider.start"; readonly draftRef: string }
export type ToolRunCommand = CommandBase & {
	readonly type: "tool.run"
	readonly turnId: TurnId
	readonly blockIds: readonly BlockId[]
}
export type DialogCommand =
	| (CommandBase & { readonly type: "dialog.prepare"; readonly interactionId: InteractionId; readonly kind: string })
	| (CommandBase & { readonly type: "dialog.reveal"; readonly interactionId: InteractionId; readonly journalRef: string })
export type ComposeRoundCommand = CommandBase & {
	readonly type: "compose.round"
	readonly turnId?: TurnId
	readonly admittedEntryIds: readonly EntryId[]
}
export type CompactionRunCommand = CommandBase & {
	readonly type: "compaction.run"
	readonly compactionId: string
	readonly attempt: AttemptId
	readonly contextRef: string
}
export type ApprovalEvaluateCommand = CommandBase & {
	readonly type: "approval.evaluate"
	readonly interactionId: InteractionId
	readonly blockId: BlockId
	readonly policyRevision: number
	readonly riskFacts: Readonly<Record<string, string | number | boolean>>
}
export type HaltStopCommand = CommandBase & {
	readonly type: "halt.stop"
	readonly haltId: HaltId
	readonly participantIds: readonly ParticipantId[]
	readonly reason: "cancel" | "terminate" | "close"
}
export type TaskSpawnCommand = CommandBase & {
	readonly type: "task.spawn"
	readonly spawnAttempt: AttemptId
	readonly handoffRef: string
	readonly haltId?: HaltId
}
export type Command =
	| ProviderStartCommand
	| ToolRunCommand
	| DialogCommand
	| ComposeRoundCommand
	| CompactionRunCommand
	| ApprovalEvaluateCommand
	| HaltStopCommand
	| TaskSpawnCommand

export type RejectReason =
	| "generation_mismatch"
	| "phase_invalid"
	| "identity_mismatch"
	| "duplicate"
	| "stale_attempt"
	| "unknown_event"
export interface Diagnostic {
	readonly code: string
	readonly message: string
}
export type TransitionResult =
	| { readonly kind: "accepted"; readonly state: TaskState; readonly commands: readonly Command[] }
	| { readonly kind: "rejected"; readonly state: TaskState; readonly reason: RejectReason; readonly diagnostic: Diagnostic }

export interface HydrateInput {
	readonly taskId: TaskId
	readonly snapshot?: TaskState
	readonly journalTail: { readonly epoch: number; readonly seq: number }
	readonly openReason: "resume" | "crash_recovery" | "checkpoint_restore" | "new"
}
export type HydrateResult =
	| {
			readonly kind: "ready"
			readonly state: TaskState
			readonly initialCommands: readonly Command[]
			readonly diagnostics: readonly Diagnostic[]
	  }
	| { readonly kind: "read_only"; readonly reason: string; readonly diagnostics: readonly Diagnostic[] }

export function createInitialTaskState(taskId: TaskId): TaskState {
	return {
		taskId,
		revision: 0,
		generation: 0,
		flow: { phase: "idle" },
		turn: { mode: "serial", blocks: [], automaticApprovalBlockIds: [], executingBlockIds: [] },
		dialog: { approvalsByBlock: {} },
		intake: { queued: [], background: [], coTask: [] },
		halt: { status: "idle", generation: 0 },
	}
}
