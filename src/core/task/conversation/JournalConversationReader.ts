import { InstanceDatabase, type InstanceLayout, instanceDatabaseExists, openInstanceStorage } from "@core/storage/instance"
import type { ClineStorageMessage } from "@shared/messages/content"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import { openTaskJournalStores } from "../stores"
import type { AdmittedResourceReader } from "../utils/admittedInputContent"

/**
 * Names the reader when it opens `journal.db`. It never writes, so it never
 * claims the database and can read a task another window is running.
 */
const CONVERSATION_READER = "conversation-reader"

/**
 * The provider conversation the journal of one instance holds.
 *
 * Resolves `undefined` when the instance has no journal yet, or an empty one,
 * so the caller decides which legacy source stands in for it. The reader never
 * creates `journal.db`, so looking at an old instance does not change it.
 *
 * Kept apart from the legacy fallback on purpose: this module does not reach
 * the task storage helpers, so tooling can decode a journal without loading
 * the extension's storage and telemetry graph. For the same reason the input
 * resources the admitted inputs placed are read through the given reader; a
 * caller that passes none sees each of them as an explicit unavailable marker.
 */
export async function readJournalConversation(
    layout: InstanceLayout,
    resources?: AdmittedResourceReader,
): Promise<ClineStorageMessage[] | undefined> {
    if (!(await instanceDatabaseExists(layout, InstanceDatabase.Journal))) return undefined
    const storage = openInstanceStorage(layout.root)
    try {
        const stores = await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, CONVERSATION_READER))
        if (stores.journal.watermark().seq === 0) return undefined
        const view = new JournalConversationView(
            stores.journal,
            new ProviderJournalMessageMaterializer(stores.payloads, resources),
        )
        return await view.messages()
    } finally {
        await storage.close()
    }
}
