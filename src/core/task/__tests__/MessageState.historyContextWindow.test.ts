import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { UIMessage } from "@core/storage/UIMessage"
import { MessageStateHandler, type MessageTaskMetadataSource } from "@core/task/message-state"
import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import type { HistoryItem } from "@shared/HistoryItem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A reopened task draws its header from the history row before it sends
 * anything, so every history update carries the figure the task last showed.
 */

vi.mock("@/utils/path", () => ({
    getCwd: vi.fn(async () => "C:\\workspace"),
    getDesktopDir: vi.fn(() => "C:\\Desktop"),
}))

function figure(overrides: Partial<ContextWindowIndicatorSnapshot> = {}): ContextWindowIndicatorSnapshot {
    return {
        taskId: "task-figure",
        revision: 5,
        epoch: 2,
        phase: "stable",
        durableContextTokens: 20_000,
        pendingSendTokens: 0,
        receivingTokens: 0,
        stagedTokens: 500,
        environmentTokens: 700,
        contextWindow: 128_000,
        mode: "act",
        updatedAt: 1_700_000_000_000,
        lineage: { kind: "baseline" },
        ...overrides,
    }
}

describe("MessageState history context-window figure", () => {
    let docsDir: string

    beforeEach(async () => {
        docsDir = await mkdtemp(path.join(os.tmpdir(), "dline-history-context-window-"))
        vi.stubEnv("DLINE_DOCS_DIR", docsDir)
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await rm(docsDir, { recursive: true, force: true })
    })

    async function persistWith(metadata: MessageTaskMetadataSource): Promise<HistoryItem | undefined> {
        const updateTaskHistory = vi.fn(async (_item: HistoryItem) => [])
        const uiMessage = await UIMessage.open("task-figure")
        const messageState = new MessageStateHandler({
            taskId: "task-figure",
            ulid: "ulid-task-figure",
            updateTaskHistory,
            uiMessage,
            metadata,
        })

        await messageState.addToClineMessages({ ts: 1, type: "say", say: "task", text: "Measure the context" })
        await messageState.close()

        return updateTaskHistory.mock.calls.at(-1)?.[0]
    }

    it("saves the figure the task header shows", async () => {
        const persisted = await persistWith({ contextWindowIndicator: figure() })

        expect(persisted?.contextWindowIndicator).toEqual(figure())
    })

    it("saves a request still in flight as the stopped figure a reopen draws", async () => {
        const persisted = await persistWith({
            contextWindowIndicator: figure({
                phase: "sending",
                pendingSendTokens: 3_000,
                lineage: { kind: "ordinary", requestId: "turn-2", requestSequence: 2, attemptId: "turn-2" },
            }),
        })

        expect(persisted?.contextWindowIndicator).toMatchObject({
            phase: "stable",
            pendingSendTokens: 0,
            durableContextTokens: 20_000,
            environmentTokens: 700,
            lineage: { kind: "baseline" },
        })
    })

    it("saves no figure before the task has shown one", async () => {
        const persisted = await persistWith({})

        expect(persisted).toBeDefined()
        expect(persisted?.contextWindowIndicator).toBeUndefined()
    })
})
