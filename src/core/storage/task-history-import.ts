import fs from "node:fs/promises"
import type { HistoryItem } from "@shared/HistoryItem"
import { Logger } from "@/shared/services/Logger"
import { fileExistsAtPath } from "@/utils/fs"
import { isHistoryItem } from "./entities/TaskHistoryRow"
import type { TaskHistory } from "./TaskHistory"

/**
 * Import a legacy `taskHistory.jsonl` into the SQLite-backed history.
 *
 * The legacy file is append-structured, so a task can appear on many lines. The
 * later line always supersedes the earlier one; reading it in any other order is
 * exactly the defect this migration repairs, so the collapse below must follow
 * file order and must not sort by timestamp first.
 *
 * The history is a derived index over `tasks/<id>/`, so a failed import is not
 * data loss: the file is left in place and the user can rebuild the index. Only
 * a successful import removes the legacy file.
 *
 * @param history Destination store, expected to be empty.
 * @param legacyPath Absolute path to the legacy `taskHistory.jsonl`.
 * @returns Number of imported tasks, or 0 when there was nothing to import.
 */
export async function importLegacyTaskHistory(history: TaskHistory, legacyPath: string): Promise<number> {
    if (!(await fileExistsAtPath(legacyPath))) return 0

    let latestById: Map<string, HistoryItem>
    try {
        latestById = collapseToLatest(await fs.readFile(legacyPath, "utf8"))
    } catch (error) {
        // A corrupt or unreadable legacy file must not block startup: an empty
        // index is recoverable, an aborted launch is not.
        Logger.warn("[TaskHistory] Could not read the legacy task history; starting with an empty index:", error)
        return 0
    }

    try {
        for (const item of latestById.values()) {
            await history.upsert(item)
        }
    } catch (error) {
        // Keep the legacy file so a later launch can retry the import.
        Logger.error("[TaskHistory] Failed to import the legacy task history:", error)
        return 0
    }

    await fs.rm(legacyPath, { force: true }).catch((error) => {
        // The import already succeeded, so a stale legacy file is harmless: the
        // database now exists and the import will not run again.
        Logger.warn("[TaskHistory] Could not remove the legacy task history file:", error)
    })
    Logger.info(`[TaskHistory] Imported ${latestById.size} tasks from the legacy history file`)
    return latestById.size
}

/**
 * Collapse legacy lines to the last valid record of each task.
 *
 * Malformed lines are skipped rather than failing the whole import, because one
 * partially written line must not cost the user the rest of their history.
 */
function collapseToLatest(content: string): Map<string, HistoryItem> {
    const latestById = new Map<string, HistoryItem>()
    for (const line of content.split(/\r?\n/u)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: unknown
        try {
            parsed = JSON.parse(trimmed)
        } catch {
            continue
        }
        // Later lines supersede earlier ones for the same task.
        if (isHistoryItem(parsed) && parsed.ts > 0) latestById.set(parsed.id, parsed)
    }
    return latestById
}
