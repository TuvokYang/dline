import type { ClineContent } from "@shared/messages"
import type { BlockLifecycle } from "../BlockPhaseMachine"
import type { InteractionKind } from "../interaction/Interaction"
import type { ActiveInteraction } from "../interaction/InteractionReducer"
import type { InteractionDraft, InteractionResponse } from "../interaction/InteractionResponse"
import type { NewTaskConsumedState, NewTaskHandoff } from "../new-task/new-task-handoff"
import type { TaskEffectType } from "./TaskEffect"
import type { CancelSource, TaskAnchor } from "./TaskRuntimeState"

/** Typed events accepted by the task runtime reducer. */
export type TaskEvent =
	| { type: "TASK_INITIALIZE_REQUESTED" }
	| { type: "TASK_INITIALIZED"; anchor: TaskAnchor; hasTask: boolean }
	| { type: "PROFILE_RECOVERY_COMMITTED"; interactionId: string }
	| { type: "PROFILE_RECOVERY_INPUT_RECEIVED"; draft: InteractionDraft }
	| { type: "API_REQUEST_STARTED"; apiIndex: number }
	| { type: "RESUME_API_CONTINUATION_REQUESTED"; apiIndex: number; draft?: InteractionDraft }
	| { type: "HOSTED_WEB_REQUEST_CONTINUATION_REQUESTED"; interactionId: string; apiIndex: number }
	| {
			type: "HOSTED_WEB_REQUEST_REJECTED"
			apiIndex: number
			turnId: string
			interactionId: string
			presentation: string
	  }
	| { type: "RESUME_BLOCK_REPLAY_REQUESTED"; turnId: string; dlineTids: string[] }
	| {
			type: "TURN_CREATED"
			turnId: string
			assistantApiIndex: number
			mode: "serial" | "parallel"
			blocks: Array<Omit<BlockLifecycle, "phase">>
	  }
	| { type: "BLOCK_READY"; turnId: string; dlineTid: string }
	| { type: "BLOCK_APPROVAL_REQUIRED"; turnId: string; dlineTid: string }
	| { type: "BLOCK_APPROVED"; turnId: string; dlineTid: string }
	| { type: "BLOCK_REJECTED"; turnId: string; dlineTid: string }
	| { type: "BLOCK_EXECUTION_STARTED"; turnId: string; dlineTid: string }
	| { type: "BLOCK_EXECUTION_REJECTED"; turnId: string; dlineTid: string }
	| { type: "BLOCK_EXECUTION_COMPLETED"; turnId: string; dlineTid: string }
	| { type: "TURN_COMPLETED"; turnId: string }
	| { type: "APPROVAL_REQUIRED"; turnId: string; interactionId: string }
	| {
			type: "INTERACTION_OPEN_REQUESTED"
			turnId: string
			interactionId: string
			kind: InteractionKind
			presentation: string
			existingTs?: number
	  }
	| {
			type: "INTERACTION_INTERRUPT_REQUESTED"
			turnId: string
			interactionId: string
			kind: InteractionKind
			presentation: string
			existingTs?: number
	  }
	| { type: "INTERACTION_PRESENTED"; interactionId: string; messageTs: number }
	| { type: "INTERACTION_RESPONDED"; response: InteractionResponse }
	| { type: "INTERACTION_RESOLVED"; interactionId: string }
	| { type: "TASK_CANCEL_REQUESTED"; source: CancelSource }
	| { type: "TASK_TERMINATE_REQUESTED" }
	| {
			type: "TASK_CANCELLED"
			resume?: { turnId: string; interactionId: string; presentation: string }
	  }
	| { type: "TASK_RESUME_REQUESTED"; interactionId: string; draft: InteractionDraft }
	| {
			type: "CHECKPOINT_CHAT_RESTORED"
			apiIndex: number
			draft?: InteractionDraft
			resume?: { turnId: string; interactionId: string; presentation: string }
	  }
	| {
			type: "ERROR_RETRY_REQUESTED"
			apiIndex: number
			draft: InteractionDraft
			/** Whether the failed request already has a durable user message at apiIndex. */
			persistedRequest?: boolean
			/** Ephemeral request content captured before it could be appended to API history. */
			retryContent?: ClineContent[]
	  }
	| { type: "MISTAKE_LIMIT_CONTINUE_REQUESTED"; apiIndex: number; draft: InteractionDraft }
	| { type: "API_RETRY_SCHEDULED"; apiIndex: number }
	| {
			type: "API_RETRY_EXHAUSTED"
			turnId: string
			interactionId: string
			presentation: string
			/** Whether the failed request already has a durable user message at apiIndex. */
			persistedRequest?: boolean
			/** Ephemeral request content captured before it could be appended to API history. */
			retryContent?: ClineContent[]
	  }
	| {
			type: "MISTAKE_LIMIT_REACHED"
			turnId: string
			interactionId: string
			apiIndex: number
			presentation: string
	  }
	| {
			type: "ATTEMPT_COMPLETION_PRESENTED"
			completionId: string
			turnId: string
			interactionId: string
			presentation: string
			existingTs?: number
	  }
	| { type: "COMPLETION_FEEDBACK_RECEIVED"; draft: InteractionDraft }
	| { type: "TASK_CLEAR_REQUESTED"; draft: InteractionDraft }
	| { type: "TASK_SUCCESSOR_REQUESTED"; handoff: NewTaskHandoff }
	| { type: "TASK_SUCCESSOR_START_COMMITTED"; source: NewTaskConsumedState }
	| { type: "TASK_COMPLETED"; completionId: string }
	| {
			type: "EFFECT_FAILED"
			effectId: string
			effectType: TaskEffectType
			originRevision: number
			originInteraction?: ActiveInteraction
			message: string
	  }
