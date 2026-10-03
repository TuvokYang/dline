import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeJsonl } from "@/core/storage/backend/jsonl/jsonl-utils"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@/core/storage/disk"
import { UIMessage } from "@/core/storage/UIMessage"
import { UIMessageWindowReader } from "@/core/storage/UIMessageWindowReader"

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

	it("indexes a multi-chunk record with only linear concatenation work", async () => {
		const filePath = path.join(dlineDocsDir, "large.jsonl")
		const message: ClineMessage = { ts: 1, type: "say", say: "text", text: "x".repeat(4 * 1024 * 1024) }
		const contents = `${JSON.stringify(message)}\n`
		await fs.writeFile(filePath, contents)
		const concat = vi.spyOn(Buffer, "concat")
		let reader: UIMessageWindowReader | undefined
		try {
			reader = await UIMessageWindowReader.open(filePath)
			const copiedBytes = concat.mock.calls.reduce(
				(total, [fragments]) => total + fragments.reduce((size, fragment) => size + fragment.length, 0),
				0,
			)
			expect(copiedBytes).toBeLessThanOrEqual(Buffer.byteLength(contents))
			expect(reader.count).toBe(1)
			await expect(reader.getLatest(1)).resolves.toEqual([message])
		} finally {
			concat.mockRestore()
			await reader?.close()
		}
	})

	it.each([true, false])("preserves UTF-8 offsets, CRLF, invalid rows and final newline=%s", async (finalNewline) => {
		const filePath = path.join(dlineDocsDir, "boundaries.jsonl")
		const prefix = JSON.stringify({ ts: 1, type: "say", say: "text", text: "" }).slice(0, -2)
		// The four-byte character straddles the reader's 64 KiB read boundary.
		const first = { ts: 1, type: "say", say: "text", text: "x".repeat(65535 - Buffer.byteLength(prefix)) + "😀尾" }
		const second = { ts: 2, type: "say", say: "text", text: "中文".repeat(50000) }
		const final = { ts: 3, type: "say", say: "text", text: "final" }
		const contents =
			[JSON.stringify(first), "invalid", "", JSON.stringify(second), JSON.stringify(final)].join("\r\n") +
			(finalNewline ? "\n" : "")
		await fs.writeFile(filePath, contents)
		const reader = await UIMessageWindowReader.open(filePath)
		try {
			expect(reader.count).toBe(3)
			await expect(reader.getPage(1, 2)).resolves.toEqual({ startIndex: 1, totalCount: 3, messages: [second, final] })
			await expect(reader.getByTimestamp(1)).resolves.toEqual(first)
			await expect(reader.getLatest(1)).resolves.toEqual([final])
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

	it("reads the exact older interaction anchor and recovery suffix without unrelated message bodies", async () => {
		const taskId = "window-recovery"
		const taskDirectory = await ensureTaskDirectoryExists(taskId)
		const messages: ClineMessage[] = [
			{ ts: 10, type: "say", say: "task", text: "title", conversationHistoryIndex: 0 },
			{ ts: 20, type: "ask", ask: "tool", interactionId: "anchor", conversationHistoryIndex: 1 },
			{ ts: 30, type: "say", say: "text", text: "unrelated", conversationHistoryIndex: 1 },
			{ ts: 40, type: "say", say: "text", text: "later API", conversationHistoryIndex: 3 },
			{ ts: 50, type: "say", say: "text", text: "suffix", conversationHistoryIndex: 2 },
		]
		await writeJsonl(path.join(taskDirectory, GlobalFileNames.uiMessages), messages)
		const reader = await UIMessage.openWindow(taskId)
		try {
			await expect(reader.getRecoveryMessages({ timestamp: 50, apiIndex: 2, interactionId: "anchor" })).resolves.toEqual([
				messages[1],
				messages[3],
				messages[4],
			])
		} finally {
			await reader.close()
		}
	})

	it("does not create a missing Task directory for display-only access", async () => {
		const taskId = "missing-readonly-history"
		const reader = await UIMessage.openWindow(taskId, { readOnly: true })
		expect(reader.count).toBe(0)
		await reader.close()
		await expect(fs.access(path.join(dlineDocsDir, "tasks", taskId))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("uses a bounded reader for new tasks and rejects reads after close", async () => {
		const reader = await UIMessage.openWindow("window-close")
		expect(reader.count).toBe(0)
		await reader.close()
		await reader.close()
		await expect(reader.getPage(-1, 20)).rejects.toThrow("UIMessageWindowReader is closed")
	})
})
