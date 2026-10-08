import type { ClineStorageMessage } from "@shared/messages/content"
import type { ConversationJournal, JournalSource, TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { ApiHistoryMessageEnvelope } from "../stores/payload/TaskPayloadEnvelopes"

const OPERATION_PREFIX = "api-history:"

const operationIdOf = (index: number) => `${OPERATION_PREFIX}${index}`

/**
 * The source the runtime would have journaled the message under.
 *
 * A chat restore walks sources to decide what still belongs to a kept row: the
 * tool results answering a kept call and the input a kept row shows. Imported
 * messages have to be filed the same way, or restoring an old row would drop a
 * result its call needs.
 */
function sourceOf(message: ClineStorageMessage): JournalSource {
	if (message.role === "assistant") return "provider"
	const answersCall = Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")
	return answersCall ? "tool" : "intake"
}

/** Whether the journal holds nothing the runtime wrote, so the import may still add to it. */
function holdsOnlyImported(recorded: readonly { readonly operationId: string }[]): boolean {
	return recorded.every((entry) => entry.operationId.startsWith(OPERATION_PREFIX))
}

/**
 * Whether {@link importApiHistory} still has messages to carry over.
 *
 * Reading only, so a window that does not own the task's `journal.db` can ask:
 * a session opened without the lock defers the import, and must reopen once it
 * owns the task, before the runtime's first write would close the import off.
 */
export async function apiHistoryImportPending(input: {
	readonly journal: ConversationJournal
	readonly history: readonly ClineStorageMessage[]
}): Promise<boolean> {
	const { journal, history } = input
	if (history.length === 0) return false
	const recorded = await journal.read()
	return holdsOnlyImported(recorded) && recorded.length < history.length
}

/**
 * Carry a task's `api_conversation_history.jsonl` into its journal, once.
 *
 * A task written before the journal existed keeps its conversation only in
 * that file, so without this its next request would start from nothing. Each
 * message becomes one journal entry, in order, so a chat row's recorded
 * conversation length still names the entry it followed.
 *
 * Every entry is keyed by its position in the file, which makes the import
 * resumable: a crash part way leaves only imported entries, and the next run
 * completes them instead of duplicating them. A journal holding anything else
 * was written by the runtime and is left alone, because appending older
 * messages after newer ones would reorder the conversation. The file itself is
 * never modified.
 *
 * The caller must own the task's `journal.db`, since this writes it.
 *
 * @returns how many messages this call appended.
 */
export async function importApiHistory(input: {
	readonly journal: ConversationJournal
	readonly payloads: TaskPayloadStore
	readonly history: readonly ClineStorageMessage[]
}): Promise<number> {
	const { journal, payloads, history } = input
	if (history.length === 0) return 0
	if (!holdsOnlyImported(await journal.read())) return 0
	let appended = 0
	for (const [index, message] of history.entries()) {
		const operationId = operationIdOf(index)
		if (await journal.findByOperation(operationId)) continue
		const envelope: ApiHistoryMessageEnvelope = { kind: "api_history_message", message }
		await journal.append({
			operationId,
			payloadRef: await payloads.put(encodeTaskPayload(envelope)),
			source: sourceOf(message),
		})
		appended++
	}
	return appended
}
