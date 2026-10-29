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
    it("keeps reasoning before commands through finalization, reopen and positional edits", async () => {
        const documentsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-message-order-"))
        process.env.DLINE_DOCUMENTS_DIRECTORY = documentsDirectory
        const taskId = "task-fixed-row-order"
        let store: UIMessage | undefined
        const createState = (uiMessage: UIMessage) =>
            new MessageStateHandler({ taskId, ulid: "fixed-row-order", updateTaskHistory: async () => [], uiMessage })
        try {
            store = await UIMessage.open(taskId)
            let state = createState(store)
            const reasoning: UiMessage = { ts: 100, type: "say", say: "reasoning", text: "Inspect command", partial: true }
            state.upsertTransientClineMessage(reasoning)
            await state.upsertClineMessageInMemory({ ts: 200, type: "say", say: "command", text: "npm test", partial: true })
            expect(state.clineMessages.map((row) => row.ts)).toEqual([100, 200])

            await state.commitTransientClineMessage({ ...reasoning, partial: false })
            expect(state.clineMessages.map((row) => row.ts)).toEqual([100, 200])
            await state.finalizeClineMessage({ ts: 200, type: "say", say: "command", text: "npm test", partial: false })
            await store.close()
            store = await UIMessage.open(taskId)
            state = createState(store)
            expect(state.clineMessages.map((row) => [row.ts, row.say, row.partial])).toEqual([
                [100, "reasoning", false],
                [200, "command", false],
            ])
            expect(state.latestMessageTs()).toBe(200)

            await state.updateClineMessage(0, { text: "Updated thought" })
            expect(store.getByTs(100)?.text).toBe("Updated thought")
            expect(store.getByTs(200)?.text).toBe("npm test")
            await state.deleteClineMessage(0)
            expect(state.clineMessages.map((row) => row.ts)).toEqual([200])
        } finally {
            await store?.close()
            await fs.rm(documentsDirectory, { recursive: true, force: true })
        }
    })

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
