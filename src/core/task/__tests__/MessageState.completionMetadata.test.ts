import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { UIMessage } from "@core/storage/UIMessage"
import { MessageStateHandler } from "@core/task/message-state"
import type { HistoryItem } from "@shared/HistoryItem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/utils/path", () => ({
    getCwd: vi.fn(async () => "C:\\workspace"),
    getDesktopDir: vi.fn(() => "C:\\Desktop"),
}))

describe("MessageState completion metadata boundary", () => {
    let docsDir: string

    beforeEach(async () => {
        docsDir = await mkdtemp(path.join(os.tmpdir(), "dline-message-completion-metadata-"))
        vi.stubEnv("DLINE_DOCS_DIR", docsDir)
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await rm(docsDir, { recursive: true, force: true })
    })

    it("does not derive task completion from completion_result messages", async () => {
        const updateTaskHistory = vi.fn(async (_item: HistoryItem) => [])
        const uiMessage = await UIMessage.open("task-1")
        const messageState = new MessageStateHandler({
            taskId: "task-1",
            ulid: "ulid-1",
            updateTaskHistory,
            uiMessage,
        })

        await messageState.addToClineMessages({ ts: 1, type: "say", say: "task", text: "Complete this task" })
        await messageState.addToClineMessages({ ts: 2, type: "say", say: "completion_result", text: "Done" })

        const latest = updateTaskHistory.mock.calls.at(-1)?.[0]
        expect(latest).toBeDefined()
        expect(latest).not.toHaveProperty("isCompleted")
        expect(latest).not.toHaveProperty("completionStateRevision")
        await messageState.close()
    })
})
