import type { ClineStorageMessage } from "@shared/messages/content"
import type { ConversationJournal, JournalSource, TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { LegacyMessageEnvelope } from "../stores/payload/TaskPayloadEnvelopes"

const LEGACY_OPERATION_PREFIX = "legacy:"

const operationIdOf = (index: number) => `${LEGACY_OPERATION_PREFIX}${index}`

/**
 * The source the runtime would have journaled the message under.
 *
 * A chat restore walks sources to decide what still belongs to a kept row: the
 * tool results answering a kept call and the input a kept row shows. Legacy
 * messages have to be filed the same way, or restoring an old row would drop a
 * result its call needs.
 */
function sourceOf(message: ClineStorageMessage): JournalSource {
	if (message.role === "assistant") return "provider"
	const answersCall = Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")
	return answersCall ? "tool" : "intake"
}

/**
 * Carry a task's pre-journal conversation into its journal, once.
 *
 * A task written before the journal existed keeps its conversation only in
 * `api_conversation_history.jsonl`, so without this its next request would
 * start from nothing. Each message becomes one journal entry, in order, so a
 * chat row's recorded conversation length still names the entry it followed.
 *
 * Every entry is keyed by its position in the legacy file, which makes the
 * import resumable: a crash part way leaves only legacy entries, and the next
 * run completes them instead of duplicating them. A journal holding anything
 * else was written by the runtime and is left alone, because appending older
 * messages after newer ones would reorder the conversation. The legacy file
 * itself is never modified.
 *
 * The caller must own the task's `journal.db`, since this writes it.
 *
 * @returns how many legacy messages this call appended.
 */
export async function importLegacyConversation(input: {
	readonly journal: ConversationJournal
	readonly payloads: TaskPayloadStore
	readonly legacy: readonly ClineStorageMessage[]
}): Promise<number> {
	const { journal, payloads, legacy } = input
	if (legacy.length === 0) return 0
	const recorded = await journal.read()
	if (!recorded.every((entry) => entry.operationId.startsWith(LEGACY_OPERATION_PREFIX))) return 0
	let appended = 0
	for (const [index, message] of legacy.entries()) {
		const operationId = operationIdOf(index)
		if (await journal.findByOperation(operationId)) continue
		const envelope: LegacyMessageEnvelope = { kind: "legacy_message", message }
		await journal.append({
			operationId,
			payloadRef: await payloads.put(encodeTaskPayload(envelope)),
			source: sourceOf(message),
		})
		appended++
	}
	return appended
}
