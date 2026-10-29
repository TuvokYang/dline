import { UIMessage } from "@core/storage/UIMessage"
import { MessageStateHandler } from "@core/task/message-state"
import type { CommandStatus, UiMessage } from "@shared/ExtensionMessage"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { closeInstanceStoragesUnder } from "@/core/storage/instance"

describe("command status persistence", () => {
    let dlineDocsDir: string

    beforeEach(async () => {
        dlineDocsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-command-status-"))
        vi.stubEnv("DLINE_DOCS_DIR", dlineDocsDir)
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await closeInstanceStoragesUnder(dlineDocsDir)
        await fs.rm(dlineDocsDir, { recursive: true, force: true })
    })

    it.each<CommandStatus>([
        "running",
        "cancelled",
        "interrupted",
        "completed",
    ])("persists %s through message-state flush and JSONL reopen", async (commandStatus) => {
        const taskId = `command-status-${commandStatus}`
        const writer = await UIMessage.open(taskId)
        await writer.addMessage({
            ts: 100,
            type: "ask",
            ask: "command",
            text: "echo test",
            commandStatus: "pending",
        } satisfies UiMessage)
        await writer.flush()

        const messageState = new MessageStateHandler({
            taskId,
            ulid: "test-ulid",
            updateTaskHistory: async () => [],
            uiMessage: writer,
        })
        await messageState.updateClineMessage(0, { commandStatus })
        await messageState.flushUiMessages()

        const reopened = await UIMessage.open(taskId)
        expect(reopened.getAt(0)?.commandStatus).toBe(commandStatus)
    })
})
