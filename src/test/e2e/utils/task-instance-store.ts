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
import { readJournalConversation } from "@/core/task/conversation/JournalConversationReader"
import { type JournalSource, openTaskJournalStores, type TaskJournalStores } from "@/core/task/stores"
import { FileTaskStateVault } from "@/core/task/stores/FileTaskStateVault"
import { encodeTaskPayload } from "@/core/task/stores/payload/TaskPayloadCodec"
import type { ClineStorageMessage } from "@/shared/messages/content"

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

const LEGACY_CONVERSATION_FILE = "api_conversation_history.jsonl"

async function readLegacyConversation(root: string): Promise<ClineStorageMessage[]> {
	try {
		const text = await readFile(path.join(root, LEGACY_CONVERSATION_FILE), "utf8")
		return text
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as ClineStorageMessage)
	} catch {
		return []
	}
}

/**
 * The provider conversation of a task, as the model sees it.
 *
 * The conversation lives in `journal.db` and is rebuilt from its entries and
 * payloads. A seeded task the extension has not run yet has only its legacy
 * `api_conversation_history.jsonl`, which is read instead. Reading never claims
 * the journal, so it works while the task is open in the extension.
 */
export async function readTaskConversation(dlineDocsDir: string, taskId: string): Promise<ClineStorageMessage[]> {
	const root = taskRoot(dlineDocsDir, taskId)
	try {
		const journal = await readJournalConversation(new InstanceLayout(root))
		if (journal) return journal
	} catch {
		// A journal the extension is still creating reads as absent until its first commit.
	}
	return await readLegacyConversation(root)
}

/**
 * The provider conversation as one JSON line per message, the shape the legacy history file had.
 *
 * `ts` is left out: the journal stamps each message when it renders it, so two
 * reads of an unchanged conversation differ only there. Without it, equal text
 * means the task holds the same conversation.
 */
export async function readTaskConversationText(dlineDocsDir: string, taskId: string): Promise<string> {
	const messages = await readTaskConversation(dlineDocsDir, taskId)
	const lines = messages.map(({ ts: _renderedAt, ...message }) => JSON.stringify(message))
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

async function withFixtureJournal<T>(root: string, work: (stores: TaskJournalStores) => Promise<T>): Promise<T> {
	const storage = openInstanceStorage(root)
	try {
		return await work(await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, E2E_FIXTURE_WRITER)))
	} finally {
		await storage.close()
	}
}

/** The journal source the runtime's legacy import assigns to a message. */
function journalSourceOf(message: ClineStorageMessage): JournalSource {
	if (message.role === "assistant") return "provider"
	return Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result") ? "tool" : "intake"
}

/**
 * Replaces the provider conversation of a closed task with `transform(current)`.
 *
 * The journal stays append-only: the earlier entries are rewound and the new
 * conversation is appended as messages, the way the runtime imports a
 * pre-journal history. Operation ids never use the `legacy:` prefix, so a
 * leftover `api_conversation_history.jsonl` is not imported on top.
 */
export async function rewriteTaskConversation(
	dlineDocsDir: string,
	taskId: string,
	transform: (messages: ClineStorageMessage[]) => ClineStorageMessage[] | Promise<ClineStorageMessage[]>,
): Promise<void> {
	const next = await transform(await readTaskConversation(dlineDocsDir, taskId))
	await withFixtureJournal(taskRoot(dlineDocsDir, taskId), async ({ journal, payloads }) => {
		const operation = `e2e-seed:${Date.now()}:${journal.watermark().seq}`
		if (journal.watermark().seq > 0) await journal.rewind({ operationId: `${operation}:rewind`, target: { seq: 0 } })
		for (const [index, message] of next.entries()) {
			await journal.append({
				operationId: `${operation}:${index}`,
				payloadRef: await payloads.put(encodeTaskPayload({ kind: "legacy_message", message })),
				source: journalSourceOf(message),
				watermark: journal.watermark(),
			})
		}
	})
}

/** Replaces the provider conversation of a closed task with `messages`. */
export async function seedTaskConversation(
	dlineDocsDir: string,
	taskId: string,
	messages: readonly ClineStorageMessage[],
): Promise<void> {
	await rewriteTaskConversation(dlineDocsDir, taskId, () => [...messages])
}

type TaskRuntimeState = NonNullable<Awaited<ReturnType<FileTaskStateVault["load"]>>>["state"]

/** The runtime state the task last committed, from `state.json`; safe to read while the task is open. */
export async function readTaskRuntimeState(dlineDocsDir: string, taskId: string): Promise<TaskRuntimeState | undefined> {
	return (await new FileTaskStateVault(new InstanceLayout(taskRoot(dlineDocsDir, taskId)).stateFile).load(taskId))?.state
}

/**
 * Leaves a closed task waiting for the user between turns, its watermark at the journal tail.
 *
 * The runtime has no idle phase for a task that stopped mid-run: it reopens
 * any such task paused, offering Resume, and a new message the user sends is
 * the next turn.
 */
export async function pauseTaskBetweenTurns(dlineDocsDir: string, taskId: string): Promise<void> {
	const root = taskRoot(dlineDocsDir, taskId)
	const vault = new FileTaskStateVault(new InstanceLayout(root).stateFile)
	const durable = await vault.load(taskId)
	if (!durable) throw new Error(`Expected runtime state for task ${taskId}`)
	const tail = await withFixtureJournal(root, async ({ journal }) => journal.watermark())
	const state = durable.state
	await vault.save({
		state: {
			...state,
			flow: { phase: "paused" },
			dialog: { approvalsByBlock: {} },
			turn: { ...state.turn, blocks: [], manualApprovalBlockIds: [], automaticApprovalBlockIds: [], executingBlockIds: [] },
			halt: { status: "idle", generation: state.generation },
			journalWatermark: tail,
		},
		outbox: [],
	})
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
