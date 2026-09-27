import { access, readFile } from "node:fs/promises"
import * as path from "node:path"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { TaskActivityRecord } from "@shared/task-activity"
import { TaskActivityRow } from "@/core/storage/activities/TaskActivityRow"
import { LEGACY_ACTIVITY_FILE } from "@/core/storage/activities/TaskActivityRowStore"
import { asc } from "@/core/storage/backend/api/UnifyStoreQuery"
import { InstanceDatabase, InstanceLayout, openInstanceStorage } from "@/core/storage/instance"
import { openUiMessageRows } from "@/core/storage/messages/openUiMessageRows"
import { readUiMessages } from "@/core/storage/messages/readUiMessages"

/**
 * Test access to the per-task databases the extension persists.
 *
 * Chat history lives in `messages.db` and activities in `activities.db`. A task
 * seeded with legacy `ui_messages.jsonl` / `activities.json` files is imported the
 * first time the extension opens it, so until then the readers fall back to the
 * legacy file.
 *
 * The rewrite helpers stage edited history for a task the extension has closed.
 * While a task is open the extension is the only writer of its databases, so a
 * test must close the task before rewriting it and reopen it afterwards.
 */

const E2E_READER = "e2e-reader"
const E2E_FIXTURE_WRITER = "e2e-fixture-writer"

function taskRoot(dlineDocsDir: string, taskId: string): string {
	return path.join(dlineDocsDir, "tasks", taskId)
}

/** The stored chat history of a task, in display order. */
export async function readTaskUiMessages(dlineDocsDir: string, taskId: string): Promise<UiMessage[]> {
	try {
		return await readUiMessages(taskRoot(dlineDocsDir, taskId))
	} catch {
		return []
	}
}

/**
 * The chat history as one JSON line per message.
 *
 * Tests that look for markers in the persisted history keep working on the same
 * text shape the legacy JSONL file had.
 */
export async function readTaskUiMessagesText(dlineDocsDir: string, taskId: string): Promise<string> {
	const messages = await readTaskUiMessages(dlineDocsDir, taskId)
	return messages.length === 0 ? "" : `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
}

async function readLegacyActivities(root: string): Promise<TaskActivityRecord[]> {
	try {
		const parsed = JSON.parse(await readFile(path.join(root, LEGACY_ACTIVITY_FILE), "utf8")) as {
			activities?: TaskActivityRecord[]
		}
		return Array.isArray(parsed.activities) ? parsed.activities : []
	} catch {
		return []
	}
}

/**
 * Replaces the stored chat history of a closed task with `transform(current)`.
 *
 * `transform` may edit the messages in place and return the same array.
 */
export async function rewriteTaskUiMessages(
	dlineDocsDir: string,
	taskId: string,
	transform: (messages: UiMessage[]) => UiMessage[] | Promise<UiMessage[]>,
): Promise<void> {
	const root = taskRoot(dlineDocsDir, taskId)
	const next = await transform(await readUiMessages(root))
	const rows = await openUiMessageRows(root, E2E_FIXTURE_WRITER)
	try {
		await rows.replaceAll(next.map((message, ordinal) => ({ ordinal, ts: message.ts, message })))
	} finally {
		await rows.close()
	}
}

/** Replaces the stored activities of a closed task with `transform(current)`. */
export async function rewriteTaskActivities(
	dlineDocsDir: string,
	taskId: string,
	transform: (activities: TaskActivityRecord[]) => TaskActivityRecord[] | Promise<TaskActivityRecord[]>,
): Promise<void> {
	const root = taskRoot(dlineDocsDir, taskId)
	const next = await transform(await readTaskActivities(dlineDocsDir, taskId))
	const storage = openInstanceStorage(root)
	try {
		const database = await storage.openDatabase(InstanceDatabase.Activities, E2E_FIXTURE_WRITER)
		const rows = await database.openStore(TaskActivityRow)
		await rows.replaceAll(next.map((record, position) => new TaskActivityRow(position, record)))
	} finally {
		await storage.close()
	}
}

/** The stored activities of a task, in list order. */
export async function readTaskActivities(dlineDocsDir: string, taskId: string): Promise<TaskActivityRecord[]> {
	const root = taskRoot(dlineDocsDir, taskId)
	try {
		await access(new InstanceLayout(root).database(InstanceDatabase.Activities))
	} catch {
		return await readLegacyActivities(root)
	}
	const storage = openInstanceStorage(root)
	try {
		const database = await storage.openDatabase(InstanceDatabase.Activities, E2E_READER)
		const rows = await database.openStore(TaskActivityRow)
		const { records } = await rows.query({ orderBy: [asc(TaskActivityRow.storage.fields.position)] })
		return records.length > 0 ? records.map((row) => row.record) : await readLegacyActivities(root)
	} catch {
		return await readLegacyActivities(root)
	} finally {
		await storage.close().catch(() => undefined)
	}
}
