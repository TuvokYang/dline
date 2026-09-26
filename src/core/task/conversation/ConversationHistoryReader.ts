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
	/** How many messages the conversation holds now, including entries written since the last read. */
	count(): Promise<number>
	/**
	 * How many messages the latest read or count saw.
	 *
	 * Only for synchronous callers that cannot wait; it lags a journal write
	 * until the next `read` or `count`.
	 */
	size(): number
	/**
	 * The journal position of the latest committed entry, which a chat row
	 * records so a restore can return to exactly that point. Undefined without
	 * a journal.
	 */
	position(): number | undefined
}

/** A task with no conversation yet, or a caller that has no journal to read. */
export const EMPTY_CONVERSATION_HISTORY: ConversationHistoryReader = {
	read: async () => [],
	count: async () => 0,
	size: () => 0,
	position: () => undefined,
}
