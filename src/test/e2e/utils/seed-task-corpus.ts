import { mkdir, open, stat } from "node:fs/promises"
import * as path from "node:path"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { ClineStorageMessage } from "@shared/messages/content"
import { seedLegacyTaskHistory } from "./task-history-store"

const JSONL_CHUNK_SIZE = 128
export const SEEDED_TASK_FILE_NAMES = {
	apiConversationHistory: "api_conversation_history.jsonl",
	uiMessages: "ui_messages.jsonl",
} as const

export interface SeedTaskCorpusOptions {
	taskCount: number
	uiMessagesPerTask: number
	apiMessagesPerTask: number
	payloadBytes: number
	idPrefix?: string
	baseTimestamp?: number
}

export interface SeededTaskCorpusEntry {
	id: string
	title: string
	uiMessageCount: number
	apiMessageCount: number
	persistedBytes: number
}

export interface SeededTaskCorpus {
	entries: SeededTaskCorpusEntry[]
	totalPersistedBytes: number
}

export async function seedTaskCorpus(dlineDocsDir: string, options: SeedTaskCorpusOptions): Promise<SeededTaskCorpus> {
	assertPositiveInteger("taskCount", options.taskCount)
	assertPositiveInteger("uiMessagesPerTask", options.uiMessagesPerTask)
	assertPositiveInteger("apiMessagesPerTask", options.apiMessagesPerTask)
	assertPositiveInteger("payloadBytes", options.payloadBytes)
	const tasksDirectory = path.join(dlineDocsDir, "tasks")
	await mkdir(tasksDirectory, { recursive: true })
	const baseTimestamp = options.baseTimestamp ?? Date.now()
	const idPrefix = options.idPrefix ?? "e2e-large-history"
	const entries: SeededTaskCorpusEntry[] = []
	const historyItems: HistoryItem[] = []

	for (let taskIndex = 0; taskIndex < options.taskCount; taskIndex++) {
		const id = `${idPrefix}-${taskIndex}`
		const title = `E2E_LARGE_HISTORY_${taskIndex}`
		const taskDirectory = path.join(tasksDirectory, id)
		await mkdir(taskDirectory, { recursive: true })
		const taskTimestamp = baseTimestamp + taskIndex * 1_000_000
		const uiMessages = createUiMessages(title, taskTimestamp, options.uiMessagesPerTask, options.payloadBytes)
		const apiMessages = createApiMessages(title, taskTimestamp, options.apiMessagesPerTask, options.payloadBytes)
		const uiPath = path.join(taskDirectory, SEEDED_TASK_FILE_NAMES.uiMessages)
		const apiPath = path.join(taskDirectory, SEEDED_TASK_FILE_NAMES.apiConversationHistory)
		await writeJsonl(uiPath, uiMessages)
		await writeJsonl(apiPath, apiMessages)
		const persistedBytes = (await stat(uiPath)).size + (await stat(apiPath)).size
		entries.push({
			id,
			title,
			uiMessageCount: uiMessages.length,
			apiMessageCount: apiMessages.length,
			persistedBytes,
		})
		historyItems.push({
			id,
			ts: taskTimestamp,
			task: title,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		})
	}

	await seedLegacyTaskHistory(dlineDocsDir, historyItems)
	return {
		entries,
		totalPersistedBytes: entries.reduce((total, entry) => total + entry.persistedBytes, 0),
	}
}

function createUiMessages(title: string, baseTimestamp: number, count: number, payloadBytes: number): ClineMessage[] {
	const messages: ClineMessage[] = [{ ts: baseTimestamp, type: "say", say: "task", text: title }]
	for (let index = 1; index < count; index++) {
		messages.push({
			ts: baseTimestamp + index,
			type: "say",
			say: "text",
			text: fixedPayload(`E2E_UI_${index}_`, payloadBytes, "u"),
		})
	}
	return messages
}

function createApiMessages(
	title: string,
	baseTimestamp: number,
	count: number,
	payloadBytes: number,
): Array<ClineStorageMessage & { ts: number }> {
	return Array.from({ length: count }, (_, index) => ({
		role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		content: fixedPayload(index === 0 ? `${title}_` : `E2E_API_${index}_`, payloadBytes, "a"),
		ts: baseTimestamp + 500_000 + index,
	}))
}

function fixedPayload(prefix: string, bytes: number, fill: string): string {
	return prefix.length >= bytes ? prefix.slice(0, bytes) : prefix.padEnd(bytes, fill)
}

async function writeJsonl(filePath: string, records: readonly unknown[]): Promise<void> {
	const handle = await open(filePath, "w")
	try {
		for (let index = 0; index < records.length; index += JSONL_CHUNK_SIZE) {
			const chunk = records.slice(index, index + JSONL_CHUNK_SIZE)
			await handle.writeFile(`${chunk.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8")
		}
	} finally {
		await handle.close()
	}
}

function assertPositiveInteger(name: string, value: number): void {
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
}
