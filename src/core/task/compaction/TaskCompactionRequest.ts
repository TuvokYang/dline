import { randomUUID } from "node:crypto"
import type { ProviderRequestScope } from "../executors/provider/service/ProviderRequest"
import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { CompactionContextEnvelope, CompactionTrigger } from "../stores/payload/TaskPayloadEnvelopes"

export type TaskCompactionMode = "summarize" | "force_truncate"

/**
 * Refusal reason when no answered span exists past the opening request.
 *
 * The conversation is already as small as compaction can make it, so callers
 * that need a smaller context treat this as done rather than as a failure.
 */
export const NOTHING_TO_COMPACT = "nothing_to_compact"

export interface TaskCompactionRequestInput {
	/** Revision the requester observed; a newer revision means the request is stale. */
	readonly stateRevision: number
	readonly mode: TaskCompactionMode
	/** Who asked; required so the recorded cause is never guessed. A manual request is reviewed before it lands. */
	readonly trigger: CompactionTrigger
	/** What the user asked the summary to keep; sent with this request only. */
	readonly guidance?: string
	/**
	 * The handler and Mode the summary is requested from, when not the task's own.
	 *
	 * A context transition sets it to the target it is about to adopt, so the
	 * conversation is condensed by the model that has to fit it.
	 */
	readonly scope?: ProviderRequestScope
}

export interface TaskCompactionRequestResult {
	readonly accepted: boolean
	readonly result: string
	/** Identity of the scheduled run, present when accepted, so a waiter can pair with exactly this run. */
	readonly compactionId?: string
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
	// The conversation the provider is actually sent, not the legacy message
	// store: a summary of anything else would describe a different
	// conversation than the one that has to shrink.
	const source = await session.conversation.read()
	if (!source.span) return { accepted: false, result: NOTHING_TO_COMPACT }

	const compactionId = `compaction:${randomUUID()}`
	// Bound before the run is admitted: the kernel may start it as soon as the
	// request commits, and the run resolves its handler when it starts.
	const scopes = input.scope ? session.owners.compactionScopes : undefined
	if (input.scope) scopes?.bind(compactionId, input.scope)
	const contextRef = await session.payloads.put(
		encodeTaskPayload<CompactionContextEnvelope>({
			kind: "compaction_context",
			// Landing replaces this span and nothing else, so input that arrives
			// while the summary is produced is kept rather than condensed unseen.
			span: source.span,
			// The reply the span ends on is the user's open input, not history:
			// landing replays it after the summary rather than condensing it.
			...(source.continuation ? { continuation: source.continuation } : {}),
			// A summary of only the oldest turns lands each call with its reply.
			...(source.replies ? { replies: source.replies } : {}),
			trigger: input.trigger,
			context: {
				mode: input.mode,
				sourceHistory: source.messages,
				// Where each summarized message lives, so a summary that covers
				// only the oldest turns lands on exactly those turns.
				...(source.sourceRanges ? { sourceRanges: source.sourceRanges } : {}),
				// What the next request carries after the summary, so the run can
				// tell when the conversation already fits and stop early.
				...(source.tail ? { tail: source.tail } : {}),
				...(input.guidance ? { guidance: input.guidance } : {}),
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
	if (submission.kind === "rejected") {
		scopes?.release(compactionId)
		return { accepted: false, result: submission.reason }
	}
	return { accepted: true, result: "scheduled", compactionId }
}
