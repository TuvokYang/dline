import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages"
import type { TaskEffectType } from "../runtime/TaskEffect"
import type { TaskSnapshot, TaskSnapshotIdentityField } from "../TaskSnapshot"

/**
 * Select the persisted UI suffix that can change a snapshot.
 *
 * A result written after the snapshot usually carries the same API index as
 * the assistant tool-use, so selecting only `apiIndex + 1` would lose it.
 * Timestamp and interaction identity keep that same-index suffix available.
 */
export function selectResumeUiTail(snapshot: TaskSnapshot, messages: readonly ClineMessage[]): ClineMessage[] {
	const interactionId = snapshot.interaction?.interactionId ?? snapshot.anchor?.interactionId
	return messages.filter(
		(message) =>
			(interactionId !== undefined && message.interactionId === interactionId) ||
			(message.conversationHistoryIndex !== undefined && message.conversationHistoryIndex > snapshot.apiIndex) ||
			message.ts >= snapshot.timestamp,
	)
}

/** Immutable inputs used by the only message-derived resume boundary. */
export interface ResumeInput {
	taskId: string
	/** Missing or invalid snapshots are rebuilt from the complete histories. */
	snapshot?: TaskSnapshot
	uiTail: readonly ClineMessage[]
	apiTail: readonly ClineStorageMessage[]
	apiTailStartIndex?: number
	apiHistoryLength: number
	/** Read exact retained anchors without materializing already-checkpointed history. */
	apiMessageAt?: (index: number) => ClineStorageMessage | undefined
	/** Complete persisted histories, required when no usable snapshot exists. */
	uiHistory?: readonly ClineMessage[]
	apiHistory?: readonly ClineStorageMessage[]
}

/** Allowed post-reconciliation entry selected without service calls. */
export type ResumeEntry =
	| { type: "reopen_interaction"; interactionId: string; turnId: string }
	| { type: "show_resume_interaction"; interactionId?: string; turnId?: string }
	| { type: "show_completion_interaction"; interactionId: string; turnId: string }
	| { type: "show_error_recovery"; interactionId: string; turnId: string; apiIndex: number }
	| { type: "show_consumed_task" }

/** Typed reconciliation diagnostic that never guesses missing identity or anchors. */
export type ResumeDiagnostic =
	| { code: "snapshot_rebuilt"; reason: "missing" | "invalid" | "task_mismatch" | "corrupt_anchor" }
	| { code: "invalid_snapshot_version" }
	| { code: "task_mismatch"; expected: string; actual?: string }
	| { code: "corrupt_anchor"; field: "apiIndex" | "uiMessageTs" }
	| { code: "unsafe_runtime_error"; effectType: TaskEffectType }
	| { code: "missing_identity"; field: TaskSnapshotIdentityField }
	| { code: "missing_interaction_anchor"; interactionId: string }
	| { code: "missing_interaction_continuation"; interactionId: string }
	| { code: "unmatched_tool_result"; dlineTid: string }
	| {
			code: "tool_result_identity_mismatch"
			dlineTid: string
			expectedFunctionId: string
			actualFunctionId: string
	  }

export interface ResumeRecoverySummary {
	readonly source: "history_open"
	readonly outcome: "clean" | "rebuilt" | "degraded" | "failed"
	readonly entryType?: ResumeEntry["type"]
	readonly failureStage?: "load" | "reconcile" | "hydrate" | "publish"
	readonly durationMs: number
	readonly diagnosticCodes: readonly ResumeDiagnostic["code"][]
	readonly persistenceFailed: boolean
}

/** Complete pure result consumed by the resume coordinator. */
export interface ResumeResult {
	snapshot: TaskSnapshot
	entry: ResumeEntry
	diagnostics: ResumeDiagnostic[]
}
