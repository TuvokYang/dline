import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiConversation } from "../ApiConversation"
import { UIMessage } from "../UIMessage"

describe("message store open boundaries", () => {
	let docsDir: string
	let previousDocsDir: string | undefined

	beforeEach(async () => {
		previousDocsDir = process.env.DLINE_DOCS_DIR
		docsDir = await mkdtemp(path.join(os.tmpdir(), "dline-message-store-open-"))
		process.env.DLINE_DOCS_DIR = docsDir
	})

	afterEach(async () => {
		if (previousDocsDir === undefined) {
			delete process.env.DLINE_DOCS_DIR
		} else {
			process.env.DLINE_DOCS_DIR = previousDocsDir
		}
		await rm(docsDir, { force: true, recursive: true })
	})

	async function createTaskDir(taskId: string): Promise<string> {
		const taskDir = path.join(docsDir, "tasks", taskId)
		await mkdir(taskDir, { recursive: true })
		return taskDir
	}

	it("opens a canonical UI JSONL file without rewriting it", async () => {
		const taskDir = await createTaskDir("canonical-ui")
		const filePath = path.join(taskDir, "ui_messages.jsonl")
		const original = `${[
			JSON.stringify({ ts: 100, type: "say", say: "task", text: "task" }),
			JSON.stringify({ ts: 200, type: "say", say: "reasoning", text: "thinking", partial: false }),
		].join("\n")}\n`
		await writeFile(filePath, original, "utf8")
		const before = await stat(filePath)

		const store = await UIMessage.open("canonical-ui")
		expect(store.getAll()).toHaveLength(2)
		await store.close()

		const after = await stat(filePath)
		expect(await readFile(filePath, "utf8")).toBe(original)
		expect(after.mtimeMs).toBe(before.mtimeMs)
	})

	it("ignores superseded partial UI rows without rewriting the JSONL file", async () => {
		const taskDir = await createTaskDir("partial-ui")
		const filePath = path.join(taskDir, "ui_messages.jsonl")
		const original = `${[
			JSON.stringify({ ts: 100, type: "say", say: "reasoning", text: "partial", partial: true }),
			JSON.stringify({ ts: 100, type: "say", say: "reasoning", text: "final", partial: false }),
			JSON.stringify({ ts: 200, type: "say", say: "text", text: "tail" }),
			JSON.stringify({ ts: 300, type: "say", say: "reasoning", text: "interrupted", partial: true }),
		].join("\n")}\n`
		await writeFile(filePath, original, "utf8")
		const before = await stat(filePath)

		const firstOpen = await UIMessage.open("partial-ui")
		expect(firstOpen.getAll()).toEqual([
			expect.objectContaining({ ts: 100, text: "final", partial: false }),
			expect.objectContaining({ ts: 200, text: "tail" }),
			expect.objectContaining({ ts: 300, text: "interrupted", partial: true }),
		])
		await firstOpen.close()

		const secondOpen = await UIMessage.open("partial-ui")
		expect(secondOpen.getAll()).toHaveLength(3)
		await secondOpen.close()
		const after = await stat(filePath)

		expect(await readFile(filePath, "utf8")).toBe(original)
		expect(after.mtimeMs).toBe(before.mtimeMs)
	})

	it("canonicalizes projected partial rows when a later durable update requires a rewrite", async () => {
		const taskDir = await createTaskDir("partial-ui-update")
		const filePath = path.join(taskDir, "ui_messages.jsonl")
		await writeFile(
			filePath,
			`${[
				JSON.stringify({ ts: 100, type: "say", say: "reasoning", text: "partial", partial: true }),
				JSON.stringify({ ts: 100, type: "say", say: "reasoning", text: "final", partial: false }),
				JSON.stringify({ ts: 200, type: "say", say: "text", text: "tail" }),
			].join("\n")}\n`,
			"utf8",
		)

		const store = await UIMessage.open("partial-ui-update")
		await store.updateMessage(0, { text: "updated" })
		await store.flush()
		await store.close()

		const persisted = (await readFile(filePath, "utf8"))
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { ts: number; text?: string; partial?: boolean })
		expect(persisted).toEqual([
			expect.objectContaining({ ts: 100, text: "updated", partial: false }),
			expect.objectContaining({ ts: 200, text: "tail" }),
		])
	})

	it("migrates duplicate complete UI timestamps once while keeping the last occurrence", async () => {
		const taskDir = await createTaskDir("duplicate-ui")
		const filePath = path.join(taskDir, "ui_messages.jsonl")
		await writeFile(
			filePath,
			`${[
				JSON.stringify({ ts: 100, type: "say", say: "reasoning", text: "old", partial: false }),
				JSON.stringify({ ts: 100, type: "say", say: "reasoning", text: "final", partial: false }),
				JSON.stringify({ ts: 200, type: "say", say: "text", text: "tail" }),
			].join("\n")}\n`,
			"utf8",
		)

		const firstOpen = await UIMessage.open("duplicate-ui")
		expect(firstOpen.getAll()).toEqual([
			expect.objectContaining({ ts: 100, text: "final", partial: false }),
			expect.objectContaining({ ts: 200, text: "tail" }),
		])
		await firstOpen.close()
		const migrated = await readFile(filePath, "utf8")
		const migratedStat = await stat(filePath)

		const secondOpen = await UIMessage.open("duplicate-ui")
		expect(secondOpen.getAll()).toHaveLength(2)
		await secondOpen.close()
		const reopenedStat = await stat(filePath)

		expect(await readFile(filePath, "utf8")).toBe(migrated)
		expect(reopenedStat.mtimeMs).toBe(migratedStat.mtimeMs)
	})

	it("imports legacy UI JSON only when the JSONL target is absent", async () => {
		const taskDir = await createTaskDir("legacy-ui")
		const legacyPath = path.join(taskDir, "ui_messages.json")
		const jsonlPath = path.join(taskDir, "ui_messages.jsonl")
		const legacy = [{ ts: 100, type: "say", say: "task", text: "legacy task" }]
		await writeFile(legacyPath, JSON.stringify(legacy), "utf8")

		const store = await UIMessage.open("legacy-ui")
		expect(store.getAll()).toEqual(legacy)
		await store.close()

		await expect(access(jsonlPath)).resolves.toBeUndefined()
		expect(await readFile(legacyPath, "utf8")).toBe(JSON.stringify(legacy))
	})

	it("preserves concurrent API messages that arrive with the same timestamp", async () => {
		await createTaskDir("same-timestamp-api")
		const left = await ApiConversation.open("same-timestamp-api")
		const right = await ApiConversation.open("same-timestamp-api")

		await Promise.all([
			left.addMessage({ role: "user", content: "left-message-1", ts: 1_000 }),
			left.addMessage({ role: "assistant", content: "left-message-2", ts: 1_000 }),
			right.addMessage({ role: "user", content: "right-message-1", ts: 1_000 }),
			right.addMessage({ role: "assistant", content: "right-message-2", ts: 1_000 }),
		])
		await Promise.all([left.close(), right.close()])

		const reopened = await ApiConversation.open("same-timestamp-api")
		expect(reopened.getAll()).toHaveLength(4)
		expect(new Set(reopened.getAll().map((message) => message.content))).toEqual(
			new Set(["left-message-1", "left-message-2", "right-message-1", "right-message-2"]),
		)
		expect(new Set(reopened.getAll().map((message) => message.ts)).size).toBe(4)
		await reopened.close()
	})

	it("assigns unique identities when atomically overwriting messages without timestamps", async () => {
		await createTaskDir("atomic-overwrite-api")
		const store = await ApiConversation.open("atomic-overwrite-api")
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000)

		try {
			await store.overwrite([
				{ role: "user", content: "first" },
				{ role: "assistant", content: "second" },
			])
			expect(store.getAll().map((message) => message.content)).toEqual(["first", "second"])
			expect(new Set(store.getAll().map((message) => message.ts)).size).toBe(2)
		} finally {
			dateNow.mockRestore()
			await store.close()
		}

		const reopened = await ApiConversation.open("atomic-overwrite-api")
		expect(reopened.getAll().map((message) => message.content)).toEqual(["first", "second"])
		expect(new Set(reopened.getAll().map((message) => message.ts)).size).toBe(2)
		await reopened.close()
	})

	it("imports and normalizes legacy API JSON only when the JSONL target is absent", async () => {
		const taskDir = await createTaskDir("legacy-api")
		const legacyPath = path.join(taskDir, "api_conversation_history.json")
		const jsonlPath = path.join(taskDir, "api_conversation_history.jsonl")
		const legacy = [
			{
				role: "assistant",
				id: "response-1",
				content: [{ type: "tool_use", id: "call-1", name: "make_plan", input: { response: "plan" } }],
				ts: 100,
			},
		]
		await writeFile(legacyPath, JSON.stringify(legacy), "utf8")

		const store = await ApiConversation.open("legacy-api")
		expect(store.getAll()).toEqual([
			expect.objectContaining({
				role: "assistant",
				provider_metadata: expect.objectContaining({ response_id: "response-1" }),
				content: [
					expect.objectContaining({
						type: "tool_use",
						function_id: "call-1",
						dline_tid: "legacy_tid_call-1",
					}),
				],
				ts: 100,
			}),
		])
		await store.close()

		await expect(access(jsonlPath)).resolves.toBeUndefined()
		expect(await readFile(legacyPath, "utf8")).toBe(JSON.stringify(legacy))
	})
})
