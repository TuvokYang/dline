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

export interface CommandFlowState {
	readonly commandId: CommandId
	readonly originRevision: number
	readonly status: "running" | "completed" | "failed" | "cancelled"
}

export interface CompactionFlowState {
	readonly compactionId: string
	readonly attempt: AttemptId
	readonly contextRef: string
	readonly status: "scheduled" | "running" | "completed" | "failed" | "expired"
	readonly resultRef?: string
	readonly message?: string
}

export interface SpawnFlowState extends CommandFlowState {
	readonly spawnAttempt: AttemptId
	readonly handoffRef: string
	readonly childTaskId?: TaskId
	readonly message?: string
}

export interface PolicyEvaluationState extends CommandFlowState {
	readonly interactionId: InteractionId
	readonly policyRevision: number
}

export interface FlowState {
	readonly phase: FlowPhase
	readonly error?: string
	readonly completionId?: string
	readonly terminalReason?: "consumed"
	readonly consumedRef?: string
	readonly compose?: CommandFlowState
	readonly provider?: CommandFlowState
	readonly compaction?: CompactionFlowState
	readonly spawn?: SpawnFlowState
}

export interface KernelBlock {
	readonly blockId: BlockId
	readonly index: number
	readonly phase: BlockPhase
	readonly attempt: AttemptId
	readonly lanes: readonly string[]
	readonly turnEnding: boolean
	readonly policy?: PolicyEvaluationState
}

export interface TurnSlice {
	readonly turnId?: TurnId
	readonly mode: "serial" | "parallel"
	readonly blocks: readonly KernelBlock[]
	readonly manualApprovalBlockIds: readonly BlockId[]
	readonly automaticApprovalBlockIds: readonly BlockId[]
	readonly executingBlockIds: readonly BlockId[]
}

export type DialogPayloadPolicy = "none" | "draft" | "selection" | "draft_and_selection"

export interface DialogActionRule {
	readonly actionId: string
	readonly payloadPolicy: DialogPayloadPolicy
}

export interface DialogAcceptedResponse {
	readonly actionId: string
	readonly stateRevision: number
	readonly receiverGeneration: number
	readonly draftRef?: string
	readonly selectionRef?: string
}

export interface DialogInteraction {
	readonly interactionId: InteractionId
	readonly turnId: TurnId
	readonly kind: string
	readonly status: "planned" | "prepared" | "awaiting" | "resolving" | "failed"
	readonly createdRevision: number
	readonly presentationRef: string
	readonly actionRules: readonly DialogActionRule[]
	readonly journalRef?: string
	readonly receiverGeneration?: number
	readonly blockId?: BlockId
	readonly acceptedResponse?: DialogAcceptedResponse
	readonly prepare?: CommandFlowState
	readonly reveal?: CommandFlowState
	readonly failure?: { readonly stage: "prepare" | "reveal"; readonly message: string }
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
interface CommandFeedbackEvent extends EventBase {
	readonly commandId: CommandId
	readonly originRevision: number
}

export type ProviderEvent =
	| (CommandFeedbackEvent & {
			readonly type: "provider.turn_ready"
			readonly turnId: TurnId
			readonly finalPayloadRef?: string
	  })
	| (CommandFeedbackEvent & { readonly type: "provider.failed"; readonly turnId?: TurnId; readonly message: string })
export type ToolEvent = EventBase & {
	readonly type: "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled"
	readonly turnId: TurnId
	readonly blockId: BlockId
	readonly message?: string
}
interface DialogRequestEvent extends EventBase {
	readonly interactionId: InteractionId
	readonly turnId: TurnId
	readonly kind: string
	readonly presentationRef: string
	readonly actionRules: readonly DialogActionRule[]
	readonly blockId?: BlockId
}

export type DialogEvent =
	| (DialogRequestEvent & { readonly type: "dialog.requested" | "dialog.interrupt_requested" })
	| (CommandFeedbackEvent & {
			readonly type: "dialog.prepared"
			readonly interactionId: InteractionId
			readonly journalRef: string
			readonly receiverGeneration: number
	  })
	| (CommandFeedbackEvent & { readonly type: "dialog.presented"; readonly interactionId: InteractionId })
	| (CommandFeedbackEvent & {
			readonly type: "dialog.failed"
			readonly interactionId: InteractionId
			readonly stage: "prepare" | "reveal"
			readonly message: string
	  })
	| (EventBase & {
			readonly type: "dialog.responded"
			readonly taskId: TaskId
			readonly turnId: TurnId
			readonly interactionId: InteractionId
			readonly stateRevision: number
			readonly receiverGeneration: number
			readonly actionId: string
			readonly draftRef?: string
			readonly selectionRef?: string
	  })
	| (EventBase & { readonly type: "dialog.reopened"; readonly interactionId: InteractionId })
	| (EventBase & { readonly type: "dialog.resolved"; readonly interactionId: InteractionId })
export type BackgroundEvent = EventBase & {
	readonly type: "background.ready"
	readonly entryId: EntryId
	readonly payloadRef: string
}
export type ComposeEvent =
	| (CommandFeedbackEvent & { readonly type: "compose.completed"; readonly draftRef: string; readonly turnId?: TurnId })
	| (CommandFeedbackEvent & { readonly type: "compose.failed"; readonly message: string; readonly turnId?: TurnId })
export type CompactionEvent =
	| (EventBase & {
			readonly type: "compaction.requested"
			readonly compactionId: string
			readonly attempt: AttemptId
			readonly contextRef: string
	  })
	| (EventBase & {
			readonly type: "compaction.started"
			readonly compactionId: string
			readonly attempt: AttemptId
	  })
	| (EventBase & {
			readonly type: "compaction.completed"
			readonly compactionId: string
			readonly attempt: AttemptId
			readonly resultRef: string
	  })
	| (EventBase & {
			readonly type: "compaction.failed" | "compaction.expired"
			readonly compactionId: string
			readonly attempt: AttemptId
			readonly message: string
	  })
export type ApprovalEvent =
	| (EventBase & {
			readonly type: "approval.requested"
			readonly turnId: TurnId
			readonly blockId: BlockId
			readonly interactionId: InteractionId
			readonly kind: string
			readonly presentationRef: string
			readonly actionRules: readonly DialogActionRule[]
	  })
	| (EventBase & {
			readonly type: "approval.evaluation_requested"
			readonly turnId: TurnId
			readonly blockId: BlockId
			readonly interactionId: InteractionId
			readonly policyRevision: number
			readonly riskFacts: Readonly<Record<string, string | number | boolean>>
			readonly attempt: AttemptId
	  })
	| (EventBase & {
			readonly type: "approval.responded"
			readonly turnId: TurnId
			readonly blockId: BlockId
			readonly interactionId: InteractionId
			readonly approved: boolean
	  })
	| (CommandFeedbackEvent & {
			readonly type: "approval.evaluated" | "approval.failed"
			readonly interactionId: InteractionId
			readonly blockId: BlockId
			readonly policyRevision: number
			readonly attempt: AttemptId
			readonly approved?: boolean
			readonly message?: string
	  })
export type CoTaskEvent = EventBase & { readonly type: "cotask.received"; readonly entryId: EntryId; readonly payloadRef: string }
export type HaltEvent = EventBase & {
	readonly type: "halt.halted" | "halt.failed"
	readonly haltId: HaltId
	readonly participantId: ParticipantId
}
export type LifecycleEvent =
	| (EventBase & { readonly type: "lifecycle.open" | "lifecycle.close" })
	| (EventBase & {
			readonly type: "lifecycle.spawn_requested"
			readonly spawnAttempt: AttemptId
			readonly handoffRef: string
			readonly haltId?: HaltId
	  })
	| (CommandFeedbackEvent & {
			readonly type: "lifecycle.spawned" | "lifecycle.spawn_failed"
			readonly spawnAttempt: AttemptId
			readonly childTaskId?: TaskId
			readonly message?: string
	  })
	| (EventBase & {
			readonly type: "lifecycle.halt_timeout"
			readonly haltId: HaltId
			readonly participantId?: ParticipantId
			readonly message?: string
	  })

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

export type ProviderStartCommand = CommandBase & {
	readonly type: "provider.start"
	readonly draftRef: string
	readonly turnId?: TurnId
}
export interface ToolRunBlock {
	readonly blockId: BlockId
	readonly attempt: AttemptId
	readonly index: number
	readonly lanes: readonly string[]
	readonly turnEnding: boolean
}
export type ToolRunCommand = CommandBase & {
	readonly type: "tool.run"
	readonly turnId: TurnId
	readonly mode: "serial" | "parallel"
	readonly blocks: readonly ToolRunBlock[]
}
interface DialogCommandInput {
	readonly interactionId: InteractionId
	readonly turnId: TurnId
	readonly kind: string
	readonly presentationRef: string
	readonly actionRules: readonly DialogActionRule[]
	readonly blockId?: BlockId
}
export type DialogCommand =
	| (CommandBase & DialogCommandInput & { readonly type: "dialog.prepare" })
	| (CommandBase &
			DialogCommandInput & {
				readonly type: "dialog.reveal"
				readonly journalRef: string
				readonly receiverGeneration: number
			})
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
	readonly attempt: AttemptId
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
export type HydrateForm = "interrupted" | "completed" | "error" | "consumed" | "new"

export type HydrateResult =
	| {
			readonly kind: "ready"
			readonly form: HydrateForm
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
		turn: { mode: "serial", blocks: [], manualApprovalBlockIds: [], automaticApprovalBlockIds: [], executingBlockIds: [] },
		dialog: { approvalsByBlock: {} },
		intake: { queued: [], background: [], coTask: [] },
		halt: { status: "idle", generation: 0 },
	}
}
