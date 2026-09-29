import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { UIMessage } from "@core/storage/UIMessage"
import { MessageStateHandler } from "@core/task/message-state"
import { type HistoryItem, MAX_HISTORY_TASK_TEXT_LENGTH } from "@shared/HistoryItem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `HistoryItem.task` is the list label, not the task itself. Storing it
 * verbatim let the single global `taskHistory` key grow without bound, which
 * is what pushed multi-megabyte state payloads to every webview. The
 * authoritative task text stays in the task's own ui_messages.jsonl.
 */

vi.mock("@/utils/path", () => ({
	getCwd: vi.fn(async () => "C:\\workspace"),
	getDesktopDir: vi.fn(() => "C:\\Desktop"),
}))

describe("MessageState history task summary", () => {
	let docsDir: string

	beforeEach(async () => {
		docsDir = await mkdtemp(path.join(os.tmpdir(), "dline-history-task-summary-"))
		vi.stubEnv("DLINE_DOCS_DIR", docsDir)
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await rm(docsDir, { recursive: true, force: true })
	})

	async function persistTaskText(taskId: string, taskText: string): Promise<HistoryItem | undefined> {
		const updateTaskHistory = vi.fn(async (_item: HistoryItem) => [])
		const uiMessage = await UIMessage.open(taskId)
		const messageState = new MessageStateHandler({
			taskId,
			ulid: `ulid-${taskId}`,
			updateTaskHistory,
			uiMessage,
		})

		await messageState.addToClineMessages({ ts: 1, type: "say", say: "task", text: taskText })
		await messageState.close()

		return updateTaskHistory.mock.calls.at(-1)?.[0]
	}

	it("stores oversized task text as a bounded label", async () => {
		const persisted = await persistTaskText("task-long", "x".repeat(50_000))

		expect(persisted?.task).toHaveLength(MAX_HISTORY_TASK_TEXT_LENGTH)
	})

	it("keeps the opening of the task so the entry stays identifiable", async () => {
		const persisted = await persistTaskText("task-prefix", `Fix the login crash${"y".repeat(50_000)}`)

		expect(persisted?.task.startsWith("Fix the login crash")).toBe(true)
	})

	it("stores short task text unchanged", async () => {
		const persisted = await persistTaskText("task-short", "Fix the login crash")

		expect(persisted?.task).toBe("Fix the login crash")
	})

	it("stores text at exactly the limit unchanged", async () => {
		const exact = "z".repeat(MAX_HISTORY_TASK_TEXT_LENGTH)
		const persisted = await persistTaskText("task-exact", exact)

		expect(persisted?.task).toBe(exact)
	})
})
