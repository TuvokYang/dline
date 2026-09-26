import type { ClineStorageMessage } from "@shared/messages/content"

/**
 * Read-only access to the provider conversation of one task.
 *
 * The journal is the conversation's only record, so everything that needs
 * what the model was told reads it through this port instead of a second
 * store that the runtime no longer writes. `api_conversation_history.jsonl`
 * is read only where a closed task is inspected by its file path.
 */
export interface ConversationHistoryReader {
	/** The conversation as the next provider request would carry it. */
	read(): Promise<ClineStorageMessage[]>
	/**
	 * How many messages the latest read returned.
	 *
	 * For synchronous callers that only need a position, such as the index a
	 * chat row records; it lags a write until the next read.
	 */
	size(): number
}

/** A task with no conversation yet, or a caller that has no journal to read. */
export const EMPTY_CONVERSATION_HISTORY: ConversationHistoryReader = {
	read: async () => [],
	size: () => 0,
}
