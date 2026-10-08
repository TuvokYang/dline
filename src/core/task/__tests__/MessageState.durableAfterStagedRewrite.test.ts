import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { UiMessage } from "@shared/ExtensionMessage"
import { afterEach, describe, expect, it } from "vitest"
import { UIMessage } from "../../storage/UIMessage"
import { MessageStateHandler } from "../message-state"

const originalDocumentsDirectory = process.env.DLINE_DOCUMENTS_DIRECTORY

afterEach(() => {
	if (originalDocumentsDirectory === undefined) delete process.env.DLINE_DOCUMENTS_DIRECTORY
	else process.env.DLINE_DOCUMENTS_DIRECTORY = originalDocumentsDirectory
})

describe("MessageState durable rows after a staged rewrite", () => {
	// A completion row becomes its dialog's anchor by being replaced in place,
	// and the user may answer before the store's timer commits that rewrite.
	it("commits a new row while an in-place replacement is still staged", async () => {
		const documentsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-durable-after-rewrite-"))
		process.env.DLINE_DOCUMENTS_DIRECTORY = documentsDirectory
		const taskId = "task-durable-after-rewrite"
		try {
			const uiMessage = await UIMessage.open(taskId)
			const state = new MessageStateHandler({
				taskId,
				ulid: "ulid-durable-after-rewrite",
				updateTaskHistory: async () => [],
				uiMessage,
			})
			await state.addToClineMessages({ ts: 100, type: "say", say: "completion_result", text: "done" })
			await state.flushUiMessages()
			await state.finalizeClineMessage({ ts: 100, type: "ask", ask: "completion_result", text: "done" })

			const reply: UiMessage = { ts: 101, type: "say", say: "user_feedback", text: "/compact keep the plan" }
			const { persistence } = state.beginDurableClineMessage(reply)
			await expect(persistence).resolves.toMatchObject({ ts: 101, say: "user_feedback" })
			await uiMessage.close()

			const reopened = await UIMessage.open(taskId)
			expect(reopened.getAll()).toEqual([
				expect.objectContaining({ ts: 100, type: "ask", ask: "completion_result" }),
				expect.objectContaining({ ts: 101, type: "say", say: "user_feedback", text: "/compact keep the plan" }),
			])
			await reopened.close()
		} finally {
			await fs.rm(documentsDirectory, { recursive: true, force: true })
		}
	})
})
