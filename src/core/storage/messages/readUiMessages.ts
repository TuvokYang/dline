import type { UiMessage } from "@/shared/ExtensionMessage"
import { InstanceDatabase, InstanceLayout, instanceDatabaseExists } from "../instance"
import { readLegacyUiMessages } from "./importLegacyUiMessages"
import { openUiMessageRows, UI_MESSAGE_READER } from "./openUiMessageRows"

/**
 * Reads the whole chat history of one instance without claiming its writer.
 *
 * `messages.db` is authoritative once it holds rows. Until the owning task first
 * opens and imports its legacy file, that file is read in place instead. A missing
 * database is not created, so reading never leaves files behind.
 */
export async function readUiMessages(instanceRoot: string): Promise<UiMessage[]> {
    if (await instanceDatabaseExists(new InstanceLayout(instanceRoot), InstanceDatabase.Messages)) {
        const rows = await openUiMessageRows(instanceRoot, UI_MESSAGE_READER)
        try {
            if ((await rows.count()) > 0) return (await rows.query()).records.map((record) => record.message)
        } finally {
            await rows.close()
        }
    }
    return (await readLegacyUiMessages(instanceRoot))?.messages ?? []
}
