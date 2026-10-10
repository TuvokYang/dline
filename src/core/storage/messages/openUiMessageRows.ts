import { InstanceDatabase, openInstanceStorage } from "../instance"
import { UiMessageRowStore } from "./UiMessageRowStore"

/** The only module that writes `messages.db`: the chat store of the open task. */
export const UI_MESSAGE_WRITER = "ui-message-projection"

/** Reads for history windows and exports. It never writes, so it never claims the database. */
export const UI_MESSAGE_READER = "ui-message-reader"

/**
 * Opens the chat rows of one instance on behalf of `owner`.
 *
 * Each call gets its own instance storage, closed together with the returned store.
 * Only {@link UI_MESSAGE_WRITER} may write; a write through any other owner fails
 * while the writer holds the database.
 */
export async function openUiMessageRows(instanceRoot: string, owner: string): Promise<UiMessageRowStore> {
    const storage = openInstanceStorage(instanceRoot)
    try {
        const database = await storage.openDatabase(InstanceDatabase.Messages, owner)
        return await UiMessageRowStore.open(database, () => storage.close())
    } catch (error) {
        await storage.close().catch(() => undefined)
        throw error
    }
}
