import { randomUUID } from "node:crypto"
import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { CompactionContextEnvelope } from "../stores/payload/TaskPayloadEnvelopes"

export type TaskCompactionMode = "summarize" | "force_truncate"

export interface TaskCompactionRequestInput {
	/** Revision the requester observed; a newer revision means the request is stale. */
	readonly stateRevision: number
	readonly mode: TaskCompactionMode
}

export interface TaskCompactionRequestResult {
	readonly accepted: boolean
	readonly result: string
}

/**
 * Admit one task-local compaction request through the kernel.
 *
 * The UI sends the revision it rendered, so a click that raced a newer turn is
 * rejected instead of compacting a conversation the user never saw. Acceptance
 * only means the kernel scheduled the run: completion arrives later as a
 * `compaction.completed` event, which keeps this path off the turn stream.
 */
export async function requestTaskCompaction(
	session: ActiveTaskSession,
	input: TaskCompactionRequestInput,
): Promise<TaskCompactionRequestResult> {
	const state = session.state()
	if (state.revision !== input.stateRevision) return { accepted: false, result: "stale_revision" }

	const compactionId = `compaction:${randomUUID()}`
	const contextRef = await session.payloads.put(
		encodeTaskPayload<CompactionContextEnvelope>({
			kind: "compaction_context",
			context: {
				mode: input.mode,
				sourceHistory: session.owners.messages.apiConversationHistory,
			},
		}),
	)
	const submission = await session.assembly.runtime.submit({
		type: "compaction.requested",
		generation: state.generation,
		compactionId,
		attempt: `${compactionId}:1`,
		contextRef,
	})
	if (submission.kind === "rejected") return { accepted: false, result: submission.reason }
	return { accepted: true, result: "scheduled" }
}
