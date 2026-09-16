import type { ClineSay } from "@shared/ExtensionMessage"
import type { ClineContent } from "@shared/messages"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import type { InteractionDraft } from "../interaction/InteractionResponse"
import type { NewTaskHandoff } from "../new-task/new-task-handoff"

/** Effect categories emitted by the task reducer. */
export type TaskEffectType =
	| "POST_TASK_VIEW"
	| "PERSIST_SNAPSHOT"
	| "CANCEL_RUNTIME"
	| "PREPARE_RESUME"
	| "START_API"
	| "EXECUTE_TOOL"
	| "APPEND_SAY"
	| "APPEND_ASK"
	| "START_NEW_TASK"
	| "START_SUCCESSOR_TASK"

/**
 * Whether a committed transition must reach its projection before the runtime
 * queue continues, or may be coalesced with the transitions that follow it.
 *
 * Both projections are last-writer-wins, so intermediate states are discardable
 * as long as a barrier forces the latest one out before anything can depend on
 * it having landed. Leaving this absent means "flushed": a transition that has
 * not been classified keeps the durable behaviour.
 */
export type SnapshotDurability = "scheduled" | "flushed"

/** Refresh the Webview from the already committed runtime state. */
export interface PostTaskViewEffect {
	id: string
	type: "POST_TASK_VIEW"
	/** Defaults to "flushed" when absent. */
	durability?: SnapshotDurability
}

/** Persist the already committed runtime aggregate. */
export interface PersistSnapshotEffect {
	id: string
	type: "PERSIST_SNAPSHOT"
	/** Defaults to "flushed" when absent. */
	durability?: SnapshotDurability
}

/** Cancel active API, hook, command, and partial tool work. */
export interface CancelRuntimeEffect {
	id: string
	type: "CANCEL_RUNTIME"
}

/** Reset cancellation-only infrastructure before any resume side effect. */
export interface PrepareResumeEffect {
	id: string
	type: "PREPARE_RESUME"
}

/** Start an API request for a known history index. */
export interface StartApiEffect {
	id: string
	type: "START_API"
	apiIndex: number
	draft?: InteractionDraft
	/** Apply the mistake-limit feedback contract before starting the provider. */
	contentTransform?: "mistake_limit"
	/** Resume one request whose complete user message is already durable at apiIndex. */
	persistedRequest?: boolean
	/** Replay one failed request whose user content had not reached API history. */
	retryContent?: ClineContent[]
}

/**
 * Execute one canonical tool lifecycle identity.
 *
 * The turn context travels with the command rather than being re-derived by the
 * executor. The scheduling decision therefore stays with the reducer, which is
 * the only place that knows the serial invariant, and the executor stays unaware
 * of whether the turn runs serially or in parallel.
 */
export interface ExecuteToolEffect {
	id: string
	type: "EXECUTE_TOOL"
	dlineTid: string
	/** Turn that owns this block, used to reject results from a superseded turn. */
	turnId?: string
	/** Scheduling mode the reducer resolved for the owning turn. */
	mode?: "serial" | "parallel"
}

/** Append a presentation-only timeline message. */
export interface AppendSayEffect {
	id: string
	type: "APPEND_SAY"
	/** Stable causal identity used to make continuation feedback idempotent. */
	interactionId?: string
	taskSay: ClineSay
	presentation: string
	images?: string[]
	files?: string[]
	userInputKind?: "direct" | "queued"
	queuedInputMode?: "queued" | "steering"
	/** Legacy handler response identity used to suppress a duplicate handler-level echo. */
	feedbackAcknowledgment?: ClineAskResponse
	/** Model-facing text used only for legacy feedback echo deduplication. */
	feedbackAcknowledgmentText?: string
}

/** Append an interaction presentation anchor. */
export interface AppendAskEffect {
	id: string
	type: "APPEND_ASK"
	interactionId: string
	taskAsk: string
	presentation: string
	existingTs?: number
}

/** Terminate the current task and create the requested successor transaction. */
export interface StartNewTaskEffect {
	id: string
	type: "START_NEW_TASK"
	draft: InteractionDraft
}

/** Start an independent successor through the current surface Controller. */
export interface StartSuccessorTaskEffect {
	id: string
	type: "START_SUCCESSOR_TASK"
	handoff: NewTaskHandoff
}

/** Data-only side effects emitted by task transitions. */
export type TaskEffect =
	| PostTaskViewEffect
	| PersistSnapshotEffect
	| CancelRuntimeEffect
	| PrepareResumeEffect
	| StartApiEffect
	| ExecuteToolEffect
	| AppendSayEffect
	| AppendAskEffect
	| StartNewTaskEffect
	| StartSuccessorTaskEffect
