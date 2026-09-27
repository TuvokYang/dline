import { access, rename } from "node:fs/promises"
import path from "node:path"
import type { UiMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { readJsonl } from "../backend/jsonl/jsonl-utils"
import type { UiMessageRowStore } from "./UiMessageRowStore"
import { isStorableMessage, type UiMessageRecord } from "./UiMessageRows"

/** Files that held the chat history before `messages.db`, newest format first. */
export const LEGACY_UI_MESSAGE_FILES = ["ui_messages.jsonl", "ui_messages.json", "claude_messages.json"] as const

export const MIGRATED_SUFFIX = ".migrated"

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

async function firstLegacyFile(instanceRoot: string): Promise<string | undefined> {
	for (const name of LEGACY_UI_MESSAGE_FILES) {
		const candidate = path.join(instanceRoot, name)
		if (await exists(candidate)) return candidate
	}
	return undefined
}

/** Later lines win for a repeated timestamp, at the position of their last write, as the JSONL store did. */
function latestPerTimestamp(messages: readonly UiMessage[]): UiMessage[] {
	const latest = new Map<number, { message: UiMessage; ordinal: number }>()
	messages.forEach((message, ordinal) => latest.set(message.ts, { message, ordinal }))
	return [...latest.values()].sort((left, right) => left.ordinal - right.ordinal).map(({ message }) => message)
}

function sameTimestamps(expected: readonly UiMessage[], stored: readonly UiMessageRecord[]): boolean {
	return expected.length === stored.length && expected.every((message, index) => message.ts === stored[index].ts)
}

export interface LegacyUiMessages {
	readonly file: string
	readonly messages: UiMessage[]
}

/**
 * Reads the legacy chat history of one instance without changing it.
 *
 * Invalid lines are skipped and a repeated timestamp keeps its last write, so the
 * result is what the JSONL store would have shown.
 */
export async function readLegacyUiMessages(instanceRoot: string): Promise<LegacyUiMessages | undefined> {
	const file = await firstLegacyFile(instanceRoot)
	if (!file) return undefined
	return { file, messages: latestPerTimestamp((await readJsonl<unknown>(file)).filter(isStorableMessage)) }
}

/**
 * Moves the chat history of one instance from its legacy file into `messages.db`.
 *
 * The file is renamed to `<name>.migrated` only after the rows are committed and read
 * back with the same timestamps in the same order, so a crash at any point leaves a
 * readable source. A database that already has rows is never overwritten: if a legacy
 * file is still present (the rename did not happen), it is renamed only when it holds
 * the same messages, and otherwise kept and reported.
 *
 * A read-back that disagrees with the file keeps the file and logs instead of
 * failing: the task must still open, and the untouched source stays available.
 */
export async function importLegacyUiMessages(instanceRoot: string, store: UiMessageRowStore): Promise<void> {
	const legacy = await readLegacyUiMessages(instanceRoot)
	if (!legacy) return
	const { file: legacyFile, messages } = legacy
	const { records: existing } = await store.query()

	if (existing.length === 0) {
		await store.replaceAll(messages.map((message, ordinal) => ({ ordinal, ts: message.ts, message })))
		const { records: stored } = await store.query()
		if (!sameTimestamps(messages, stored)) {
			Logger.error(
				`[messages.db] UiMessageImportMismatch: ${legacyFile} imported ${stored.length} of ${messages.length} messages; keeping the file`,
			)
			return
		}
	} else if (!sameTimestamps(messages, existing)) {
		Logger.warn(
			`[messages.db] Keeping ${legacyFile}: it holds ${messages.length} messages but messages.db already holds ${existing.length}`,
		)
		return
	}
	await rename(legacyFile, `${legacyFile}${MIGRATED_SUFFIX}`)
}
