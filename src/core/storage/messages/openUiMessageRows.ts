import { InstanceDatabase, InstanceLayout, instanceDatabaseExists, openInstanceStorage } from "../instance"
import { UiMessageRowStore, UiMessageRowsMissing } from "./UiMessageRowStore"

/** The only module that writes `messages.db`: the chat store of the open task. */
export const UI_MESSAGE_WRITER = "ui-message-projection"

/** Reads for history windows and exports. It never writes, so it never claims the database. */
export const UI_MESSAGE_READER = "ui-message-reader"

/**
 * Opens the chat rows of one instance on behalf of `owner`.
 *
 * Each call gets its own instance storage, closed together with the returned store.
 * Only {@link UI_MESSAGE_WRITER} may write, so only it creates missing collections;
 * every other owner opens what exists. A write through any other owner fails
 * while the writer holds the database.
 */
export async function openUiMessageRows(instanceRoot: string, owner: string): Promise<UiMessageRowStore> {
    const storage = openInstanceStorage(instanceRoot)
    try {
        const database = await storage.openDatabase(InstanceDatabase.Messages, owner)
        const collections = owner === UI_MESSAGE_WRITER ? "create" : "existing"
        return await UiMessageRowStore.open(database, () => storage.close(), instanceRoot, collections)
    } catch (error) {
        await storage.close().catch(() => undefined)
        throw error
    }
}

/**
 * Opens the chat rows of one instance for reading, or resolves undefined when it
 * holds none. Nothing is created or changed on disk: an absent `messages.db`, or
 * one without its chat row collections, holds no rows.
 */
export async function openStoredUiMessageRows(instanceRoot: string): Promise<UiMessageRowStore | undefined> {
    if (!(await instanceDatabaseExists(new InstanceLayout(instanceRoot), InstanceDatabase.Messages))) return undefined
    try {
        return await openUiMessageRows(instanceRoot, UI_MESSAGE_READER)
    } catch (error) {
        if (error instanceof UiMessageRowsMissing) return undefined
        throw error
    }
}
