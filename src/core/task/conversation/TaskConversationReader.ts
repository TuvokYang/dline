import { getSavedApiConversationHistory } from "@core/storage/disk"
import { resolveInstanceLayout } from "@core/storage/instance"
import type { ClineStorageMessage } from "@shared/messages/content"
import { readJournalConversation } from "./JournalConversationReader"

/**
 * The provider conversation a task holds, whether or not it is open.
 *
 * The journal is the conversation of every task this build wrote. A task from
 * an older build that was never opened since has only its legacy history file,
 * which is read as-is. The reader never creates `journal.db`, so looking at an
 * old task does not change it.
 */
export async function readTaskConversation(taskId: string): Promise<ClineStorageMessage[]> {
	const layout = await resolveInstanceLayout({ taskId })
	return (await readJournalConversation(layout)) ?? getSavedApiConversationHistory(taskId)
}
