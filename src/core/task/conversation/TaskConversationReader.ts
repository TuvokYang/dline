import { getSavedApiConversationHistory } from "@core/storage/disk"
import { InstanceDatabase, openInstanceStorage, resolveInstanceLayout } from "@core/storage/instance"
import type { ClineStorageMessage } from "@shared/messages/content"
import { fileExistsAtPath } from "@utils/fs"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import { openTaskJournalStores } from "../stores"

/**
 * Names the reader when it opens `journal.db`. It never writes, so it never
 * claims the database and can read a task another window is running.
 */
const CONVERSATION_READER = "conversation-reader"

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
	if (!(await fileExistsAtPath(layout.database(InstanceDatabase.Journal)))) return getSavedApiConversationHistory(taskId)
	const storage = openInstanceStorage(layout.root)
	try {
		const stores = await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, CONVERSATION_READER))
		if (stores.journal.watermark().seq === 0) return getSavedApiConversationHistory(taskId)
		const view = new JournalConversationView(stores.journal, new ProviderJournalMessageMaterializer(stores.payloads))
		return await view.messages()
	} finally {
		await storage.close()
	}
}
