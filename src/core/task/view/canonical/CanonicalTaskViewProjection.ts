import type { BlockId, DialogPayloadPolicy, FlowPhase, JournalWatermark, ParticipantId } from "../../kernel"

export type CanonicalTaskTerminal = "active" | "completed" | "error" | "consumed" | "terminated"

export type CanonicalTaskActivity = "idle" | "working" | "waiting" | "waiting_for_dialog" | "halting" | "terminal"

/**
 * `reply` admits one ordinary submission while no dialog owns the input, after
 * the user dismissed the failure that stopped the round.
 */
export type CanonicalTaskInputMode = "disabled" | "queued" | "dialog" | "reply"

export interface CanonicalTaskInputProjection {
	readonly mode: CanonicalTaskInputMode
	readonly ownerInteractionId?: string
	readonly ownerBlockId?: BlockId
}

export interface CanonicalDialogActionProjection {
	readonly actionId: string
	readonly payloadPolicy: DialogPayloadPolicy
	readonly enabled: boolean
}

export interface CanonicalDialogProjection {
	readonly scope: "primary" | "approval" | "interrupted"
	readonly blockId?: BlockId
	readonly interactionId: string
	readonly turnId: string
	readonly kind: string
	readonly status: "planned" | "prepared" | "awaiting" | "resolving" | "failed"
	readonly createdRevision: number
	readonly stateRevision: number
	readonly receiverGeneration?: number
	readonly presentationRef: string
	readonly journalRef?: string
	readonly journalWatermark?: JournalWatermark
	readonly actions: readonly CanonicalDialogActionProjection[]
	readonly failure?: { readonly stage: "prepare" | "reveal"; readonly message: string }
}

export type CanonicalHaltProjection =
	| { readonly status: "idle"; readonly generation: number }
	| {
			readonly status: "stopping"
			readonly generation: number
			readonly haltId: string
			readonly target: "paused" | "terminated"
			readonly pending: readonly ParticipantId[]
			readonly halted: readonly ParticipantId[]
			readonly failed: readonly ParticipantId[]
			readonly timedOut: readonly ParticipantId[]
	  }

export interface CanonicalTaskActionProjection {
	readonly actionId: "cancel"
	readonly enabled: boolean
}

export interface CanonicalCompactionProjection {
	readonly compactionId: string
	readonly attempt: string
	readonly status: "scheduled" | "running" | "completed" | "failed" | "expired"
	readonly resultRef?: string
	readonly message?: string
}

export interface CanonicalTaskDiagnostic {
	readonly code:
		| "task_error"
		| "dialog_failed"
		| "dialog_receiver_generation_missing"
		| "approval_block_missing"
		| "forced_closed"
	readonly message: string
	readonly interactionId?: string
	readonly blockId?: BlockId
}

export interface CanonicalTaskViewProjection {
	readonly taskId: string
	readonly revision: number
	readonly generation: number
	readonly flowPhase: FlowPhase
	readonly terminal: CanonicalTaskTerminal
	readonly activity: CanonicalTaskActivity
	readonly input: CanonicalTaskInputProjection
	readonly taskActions: readonly CanonicalTaskActionProjection[]
	readonly primary?: CanonicalDialogProjection
	readonly approvals: readonly CanonicalDialogProjection[]
	readonly interrupted?: CanonicalDialogProjection
	readonly halt: CanonicalHaltProjection
	readonly compaction?: CanonicalCompactionProjection
	readonly journalWatermark?: JournalWatermark
	readonly diagnostics: readonly CanonicalTaskDiagnostic[]
}
