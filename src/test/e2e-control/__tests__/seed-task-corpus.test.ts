import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages/content"
import { afterEach, describe, expect, it } from "vitest"
import { readJsonl } from "@/core/storage/backend/jsonl/jsonl-utils"
import { SEEDED_TASK_FILE_NAMES, seedTaskCorpus } from "@/test/e2e/utils/seed-task-corpus"
import { legacyTaskHistoryPath } from "@/test/e2e/utils/task-history-store"

describe("seedTaskCorpus", () => {
	let root: string | undefined

	afterEach(async () => {
		if (root) await rm(root, { force: true, recursive: true })
		root = undefined
	})

	it("writes valid timestamped UI and API JSONL for every seeded task", async () => {
		root = await mkdtemp(path.join(tmpdir(), "dline-seed-task-corpus-"))
		const corpus = await seedTaskCorpus(root, {
			taskCount: 2,
			uiMessagesPerTask: 5,
			apiMessagesPerTask: 4,
			payloadBytes: 256,
			idPrefix: "fixture",
			baseTimestamp: 1_000,
		})

		expect(corpus.entries).toHaveLength(2)
		expect(corpus.totalPersistedBytes).toBeGreaterThan(2_000)
		for (const entry of corpus.entries) {
			const taskDirectory = path.join(root, "tasks", entry.id)
			const uiMessages = await readJsonl<ClineMessage>(path.join(taskDirectory, SEEDED_TASK_FILE_NAMES.uiMessages))
			const apiMessages = await readJsonl<ClineStorageMessage>(
				path.join(taskDirectory, SEEDED_TASK_FILE_NAMES.apiConversationHistory),
			)
			expect(uiMessages).toHaveLength(5)
			expect(apiMessages).toHaveLength(4)
			expect(uiMessages[0]).toMatchObject({ type: "say", say: "task", text: entry.title })
			expect(new Set(uiMessages.map((message) => message.ts)).size).toBe(uiMessages.length)
			expect(new Set(apiMessages.map((message) => message.ts)).size).toBe(apiMessages.length)
			expect(apiMessages.every((message) => typeof message.ts === "number" && message.ts > 0)).toBe(true)
			expect(entry.persistedBytes).toBeGreaterThan(1_000)
		}

		const historyLines = (await readFile(legacyTaskHistoryPath(root), "utf8")).trim().split("\n")
		expect(historyLines).toHaveLength(2)
		expect(historyLines.map((line) => JSON.parse(line).id)).toEqual(["fixture-0", "fixture-1"])
	})
})
