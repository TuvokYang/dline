import { type CheckpointReferenceSet, readCheckpointReferenceSet } from "@shared/checkpoints"
import type { ClineMessage } from "@shared/ExtensionMessage"

/** Return true when a persisted row represents a completed task boundary. */
function isCompletionMessage(message: ClineMessage): boolean {
	return message.say === "completion_result" || message.ask === "completion_result"
}

/**
 * Resolve the older checkpoint for one completion segment.
 *
 * A completion row is first published as a `say` and then rewritten in place as
 * an `ask` while Dline waits for feedback. Both forms therefore represent the
 * same durable boundary. The first completion falls back to the task-start
 * checkpoint; later completions use the closest earlier completion with a
 * checkpoint hash.
 */
export function resolveCompletionDiffBaseReferences(
	messages: readonly ClineMessage[],
	messageIndex: number,
): CheckpointReferenceSet | undefined {
	for (let index = messageIndex - 1; index >= 0; index--) {
		const message = messages[index]
		const references = message && isCompletionMessage(message) ? readCheckpointReferenceSet(message) : undefined
		if (references) {
			return references
		}
	}

	for (const message of messages) {
		if (message.say === "checkpoint_created") {
			const references = readCheckpointReferenceSet(message)
			if (references) return references
		}
	}
	return undefined
}

/** Compatibility helper for callers that still operate on one workspace. */
export function resolveCompletionDiffBaseHash(messages: readonly ClineMessage[], messageIndex: number): string | undefined {
	return resolveCompletionDiffBaseReferences(messages, messageIndex)?.hashes.find(Boolean)
}
