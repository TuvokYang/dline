import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeJsonl } from "@/core/storage/backend/jsonl/jsonl-utils"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@/core/storage/disk"
import { UIMessage } from "@/core/storage/UIMessage"

describe("UIMessage history windows", () => {
	let dlineDocsDir: string

	beforeEach(async () => {
		dlineDocsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-ui-window-"))
		vi.stubEnv("DLINE_DOCS_DIR", dlineDocsDir)
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await fs.rm(dlineDocsDir, { recursive: true, force: true })
	})

	it("reads absolute pages without retaining the whole canonical JSONL body", async () => {
		const taskId = "window-pages"
		const messages = Array.from(
			{ length: 600 },
			(_, index): ClineMessage => ({
				ts: index + 1,
				type: "say",
				say: index === 0 ? "task" : "text",
				text: `${index}:`.padEnd(8 * 1024, "x"),
			}),
		)
		const writer = await UIMessage.open(taskId)
		await writer.overwrite(messages)
		await writer.close()

		const reader = await UIMessage.openWindow(taskId)
		try {
			expect(reader.count).toBe(600)
			expect((await reader.getLatest(20)).map((message) => message.ts)).toEqual(
				Array.from({ length: 20 }, (_, index) => 581 + index),
			)
			await expect(reader.getPage(100, 3)).resolves.toMatchObject({
				startIndex: 100,
				totalCount: 600,
				messages: [{ ts: 101 }, { ts: 102 }, { ts: 103 }],
			})
			await expect(reader.getByTimestamp(350)).resolves.toMatchObject({ ts: 350 })
		} finally {
			await reader.close()
		}
	})

	it("keeps the last duplicate timestamp in its final logical position", async () => {
		const taskId = "window-dedup"
		const taskDirectory = await ensureTaskDirectoryExists(taskId)
		await writeJsonl(path.join(taskDirectory, GlobalFileNames.uiMessages), [
			{ ts: 10, type: "say", say: "text", text: "old" },
			{ ts: 20, type: "say", say: "text", text: "middle" },
			{ ts: 10, type: "say", say: "text", text: "final" },
		])

		const reader = await UIMessage.openWindow(taskId)
		try {
			expect(reader.count).toBe(2)
			expect((await reader.getPage(0, 2)).messages.map((message) => [message.ts, message.text])).toEqual([
				[20, "middle"],
				[10, "final"],
			])
		} finally {
			await reader.close()
		}
	})

	it("uses a bounded reader for new tasks and rejects reads after close", async () => {
		const reader = await UIMessage.openWindow("window-close")
		expect(reader.count).toBe(0)
		await reader.close()
		await reader.close()
		await expect(reader.getPage(-1, 20)).rejects.toThrow("UIMessageWindowReader is closed")
	})
})
