import type { UiMessage } from "@shared/ExtensionMessage"

/** Return true when a persisted row represents a completed task boundary. */
function isCompletionMessage(message: UiMessage): boolean {
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
export function resolveCompletionDiffBaseHash(messages: readonly UiMessage[], messageIndex: number): string | undefined {
	for (let index = messageIndex - 1; index >= 0; index--) {
		const message = messages[index]
		if (message && isCompletionMessage(message) && message.lastCheckpointHash) {
			return message.lastCheckpointHash
		}
	}

	return messages.find((message) => message.say === "checkpoint_created" && message.lastCheckpointHash)?.lastCheckpointHash
}
