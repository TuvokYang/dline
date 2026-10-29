import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import { SqliteUnifyStoreBackend } from "@/core/storage/backend/sqlite/SqliteUnifyStore"
import { TaskHistoryRow } from "@/core/storage/entities/TaskHistoryRow"

/**
 * Read-side access to the task history the extension actually persists.
 *
 * The history moved from an append-structured `taskHistory.jsonl` to a
 * SQLite store keyed by task id, so assertions must query the database rather
 * than count file lines. Seeding still writes the legacy file: the extension
 * imports it once on first launch, which keeps the migration itself covered.
 */

/** Absolute path of the task history database owned by a Dline documents dir. */
export function taskHistoryDatabasePath(dlineDocsDir: string): string {
    return path.join(dlineDocsDir, "tasks", "taskHistory.db")
}

/** Absolute path of the legacy JSONL history, used only to seed a migration. */
export function legacyTaskHistoryPath(dlineDocsDir: string): string {
    return path.join(dlineDocsDir, "tasks", "taskHistory.jsonl")
}

/**
 * Seed a legacy history file for the extension to import on first launch.
 *
 * Callers may pass several records with the same id; the later record wins,
 * matching the append semantics of the file this migration replaces.
 */
export async function seedLegacyTaskHistory(dlineDocsDir: string, items: readonly HistoryItem[]): Promise<void> {
    const filePath = legacyTaskHistoryPath(dlineDocsDir)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8")
}

/**
 * Read every stored entry, newest first.
 *
 * Opens its own connection and closes it before returning so a polling
 * assertion never holds the database open against the extension under test.
 * A missing or not-yet-created database reads as an empty history.
 */
export async function readStoredTaskHistory(dlineDocsDir: string): Promise<HistoryItem[]> {
    const database = await new SqliteUnifyStoreBackend().open(taskHistoryDatabasePath(dlineDocsDir)).catch(() => undefined)
    if (!database) return []
    try {
        const store = await database.openStore(TaskHistoryRow)
        const { records } = await store.query()
        return records.map((row) => row.toHistoryItem()).sort((a, b) => b.ts - a.ts)
    } catch {
        return []
    } finally {
        await database.close().catch(() => undefined)
    }
}

/** Read the stored entry for one task, or undefined when it is absent. */
export async function readStoredTaskHistoryItem(dlineDocsDir: string, taskId: string): Promise<HistoryItem | undefined> {
    return (await readStoredTaskHistory(dlineDocsDir)).find((item) => item.id === taskId)
}

/** Count the stored entries for one task; the id is a primary key, so this is 0 or 1. */
export async function countStoredRowsForTask(dlineDocsDir: string, taskId: string): Promise<number> {
    return (await readStoredTaskHistory(dlineDocsDir)).filter((item) => item.id === taskId).length
}

/** Count every stored entry. */
export async function countStoredTaskHistory(dlineDocsDir: string): Promise<number> {
    return (await readStoredTaskHistory(dlineDocsDir)).length
}
