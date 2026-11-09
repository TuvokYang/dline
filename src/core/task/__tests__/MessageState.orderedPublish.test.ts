import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveInstanceLayout } from "../../storage/instance"
import { openUiMessageRows, UI_MESSAGE_READER } from "../../storage/messages/openUiMessageRows"
import { UIMessage } from "../../storage/UIMessage"
import { MessageStateHandler } from "../message-state"

const originalDocs = process.env.DLINE_DOCS_DIR
const originalDocuments = process.env.DLINE_DOCUMENTS_DIRECTORY

function restoreEnvironment(): void {
    if (originalDocs === undefined) delete process.env.DLINE_DOCS_DIR
    else process.env.DLINE_DOCS_DIR = originalDocs
    if (originalDocuments === undefined) delete process.env.DLINE_DOCUMENTS_DIRECTORY
    else process.env.DLINE_DOCUMENTS_DIRECTORY = originalDocuments
}

afterEach(restoreEnvironment)

describe("MessageState ordered publish", () => {
    it("places a retained row at its reserved timestamp instead of after rows written later", async () => {
        const documentsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-ordered-publish-"))
        process.env.DLINE_DOCS_DIR = documentsDirectory
        process.env.DLINE_DOCUMENTS_DIRECTORY = documentsDirectory
        const taskId = "task-ordered-publish"
        let store: UIMessage | undefined
        try {
            store = await UIMessage.open(taskId)
            const state = new MessageStateHandler({
                taskId,
                ulid: "ordered-publish",
                updateTaskHistory: async () => [],
                uiMessage: store,
            })

            // The round writes these after the retained input reserved 100.
            await state.addToClineMessages({ ts: 200, type: "say", say: "checkpoint_created" })
            await state.addToClineMessages({
                ts: 300,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "readFile", path: "a.ts" }),
            })
            await state.addToClineMessagesOrdered({
                ts: 100,
                type: "say",
                say: "user_feedback",
                text: "steer the round",
            })

            expect(state.clineMessages.map((row) => row.ts)).toEqual([100, 200, 300])
            await store.close()
            store = undefined

            const reopened = await UIMessage.open(taskId)
            expect(reopened.getAll().map((row) => row.ts)).toEqual([100, 200, 300])
            await reopened.close()

            const committed = await openUiMessageRows((await resolveInstanceLayout({ taskId })).root, UI_MESSAGE_READER)
            try {
                expect((await committed.commitLog.head()).violationTs).toBeNull()
            } finally {
                await committed.close()
            }
        } finally {
            await store?.close().catch(() => undefined)
            restoreEnvironment()
            await fs.rm(documentsDirectory, { recursive: true, force: true })
        }
    })

    it("patches the same message when an earlier row is inserted while both writes wait on the lock", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-ordered-patch-"))
        process.env.DLINE_DOCS_DIR = root
        process.env.DLINE_DOCUMENTS_DIRECTORY = root
        const store = await UIMessage.open("task-ordered-patch")
        try {
            const state = new MessageStateHandler({
                taskId: "task-ordered-patch",
                ulid: "ordered-patch",
                updateTaskHistory: async () => [],
                uiMessage: store,
            })
            await state.addToClineMessages({ ts: 200, type: "say", say: "checkpoint_created", text: "checkpoint" })
            await state.addToClineMessages({ ts: 300, type: "say", say: "api_req_started", text: "pending" })
            // Control the existing store lock, not the patch result: both operations
            // read the old positions before either is allowed to mutate the buffer.
            const { mutex } = (
                store as unknown as {
                    store: { mutex: { withLock<T>(action: () => Promise<T>): Promise<T> } }
                }
            ).store
            let release!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const held = mutex.withLock(() => gate)
            const insert = state.addToClineMessagesOrdered({
                ts: 100,
                type: "say",
                say: "user_feedback",
                text: "steer",
                conversationHistoryIndex: 0,
            })
            const patch = state.updateClineMessage(1, { text: "settled usage" })
            release()
            await Promise.all([held, insert, patch])
            await state.flushUiMessages()
            expect(state.clineMessages.map(({ ts, text }) => ({ ts, text }))).toEqual([
                { ts: 100, text: "steer" },
                { ts: 200, text: "checkpoint" },
                { ts: 300, text: "settled usage" },
            ])
            await store.close()
            const reopened = await UIMessage.open("task-ordered-patch")
            try {
                expect(reopened.getAll().map(({ ts, text }) => ({ ts, text }))).toEqual([
                    { ts: 100, text: "steer" },
                    { ts: 200, text: "checkpoint" },
                    { ts: 300, text: "settled usage" },
                ])
            } finally {
                await reopened.close()
            }
        } finally {
            await store.close()
            restoreEnvironment()
            await fs.rm(root, { recursive: true, force: true })
        }
    })
})
