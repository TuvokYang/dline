import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileExistsAtPath } from "@utils/fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openTaskPersistence } from "../../shell/TaskPersistenceAssembly"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import { readTaskConversation } from "../TaskConversationReader"

describe("readTaskConversation", () => {
	let documentsRoot: string

	beforeEach(async () => {
		documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-conversation-reader-"))
		vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await rm(documentsRoot, { recursive: true, force: true })
	})

	async function journalTask(taskId: string, text: string) {
		const persistence = await openTaskPersistence(taskId)
		const payloadRef = await persistence.payloads.put(encodeTaskPayload({ kind: "user_input", text }))
		await persistence.ports.journal.append({ operationId: "intake:user:1", payloadRef, source: "intake" })
		return persistence
	}

	it("reads the conversation a task journaled", async () => {
		await (await journalTask("task-journal", "from the journal")).close?.()

		const messages = await readTaskConversation("task-journal")

		expect(JSON.stringify(messages)).toContain("from the journal")
	})

	it("reads a task another window is writing without claiming its journal", async () => {
		const writer = await journalTask("task-open", "still running")
		try {
			expect(JSON.stringify(await readTaskConversation("task-open"))).toContain("still running")
			const payloadRef = await writer.payloads.put(encodeTaskPayload({ kind: "user_input", text: "written after" }))
			await expect(
				writer.ports.journal.append({ operationId: "intake:user:2", payloadRef, source: "intake" }),
			).resolves.toMatchObject({ disposition: "appended" })
		} finally {
			await writer.close?.()
		}
	})

	it("reads a legacy task's history file without creating a journal", async () => {
		const taskDir = path.join(documentsRoot, "tasks", "task-legacy")
		await mkdir(taskDir, { recursive: true })
		const legacy = { role: "user", content: [{ type: "text", text: "from an older build" }], ts: 1 }
		await writeFile(path.join(taskDir, "api_conversation_history.jsonl"), `${JSON.stringify(legacy)}\n`)

		const messages = await readTaskConversation("task-legacy")

		expect(JSON.stringify(messages)).toContain("from an older build")
		expect(await fileExistsAtPath(path.join(taskDir, "journal.db"))).toBe(false)
	})
})
