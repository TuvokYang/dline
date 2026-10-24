import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import type { UiMessage } from "@/shared/ExtensionMessage"

vi.unmock("@integrations/checkpoints")

import { DefaultToolHandlerState } from "@/core/task/tools/state/ToolHandlerState"
import { createTaskCheckpointManager } from "../index"
import type { CanonicalCheckpointPort } from "../types"

interface RestoreHarness {
    manager: ReturnType<typeof createTaskCheckpointManager>
    taskState: DefaultToolHandlerState
    resetHead: ReturnType<typeof vi.fn>
    restoreFiles: ReturnType<typeof vi.fn>
    closeAllDiffs: ReturnType<typeof vi.fn>
    getDiffSet: ReturnType<typeof vi.fn>
    restoreChatRuntime: ReturnType<typeof vi.fn>
    resumeTask: ReturnType<typeof vi.fn>
    persistTaskHistory: ReturnType<typeof vi.fn>
    postStateToWebview: ReturnType<typeof vi.fn>
    truncateContextHistory: ReturnType<typeof vi.fn>
    truncateApiHistory: ReturnType<typeof vi.fn>
    truncateUiHistory: ReturnType<typeof vi.fn>
    clearTransientClineMessages: ReturnType<typeof vi.fn>
}

function createHarness(
    messages: UiMessage[],
    trackedFiles?: string[],
    apiHistoryLength = 2,
    conversationRewind?: { rewindTo: ReturnType<typeof vi.fn> },
    canonicalCheckpoint?: CanonicalCheckpointPort,
    workspacePath?: string,
): RestoreHarness {
    const taskState = Object.assign(new DefaultToolHandlerState(), {
        userMessageContent: [{ type: "text", text: "active user content" }],
        assistantMessageContent: [{ type: "text", text: "active assistant content" }],
        userMessageContentReady: true,
        lastMessageTs: 99,
        consecutiveMistakeCount: 3,
        consecutiveIdenticalToolCount: 4,
        lastToolName: "replace_in_file",
        lastToolParams: "stale-params",
    })
    const resetHead = vi.fn().mockResolvedValue(undefined)
    const restoreFiles = vi.fn().mockResolvedValue(undefined)
    const closeAllDiffs = vi.mocked(HostProvider.diff.closeAllDiffs)
    closeAllDiffs.mockClear()
    closeAllDiffs.mockResolvedValue({})
    const changedPath = trackedFiles?.[0] ?? path.resolve("C:/workspace/changed.ts")
    const getDiffSet = vi
        .fn()
        .mockResolvedValue([
            { relativePath: path.basename(changedPath), absolutePath: changedPath, before: "before", after: "after" },
        ])
    const restoreChatRuntime = vi.fn().mockResolvedValue(undefined)
    const resumeTask = vi.fn().mockResolvedValue(undefined)
    const truncateApiHistory = vi.fn().mockResolvedValue(undefined)
    const truncateUiHistory = vi.fn().mockResolvedValue(undefined)
    const apiConversation = {
        count: apiHistoryLength,
        truncateByLineNum: truncateApiHistory,
        getAt: vi.fn(),
    }
    const uiMessage = { count: messages.length, truncateByLineNum: truncateUiHistory }
    const persistTaskHistory = vi.fn().mockResolvedValue(undefined)
    const postStateToWebview = vi.fn().mockResolvedValue(undefined)
    const truncateContextHistory = vi.fn().mockResolvedValue(undefined)
    const clearTransientClineMessages = vi.fn().mockReturnValue([])
    const messageStateHandler = {
        clineMessages: messages,
        // Restore reads the durable sequence, which excludes presentation overlays.
        // These fixtures carry durable rows only, so both views are identical here.
        durableClineMessages: messages,
        clearTransientClineMessages,
        apiConversationHistory: Array.from({ length: apiHistoryLength }, (_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            content: `message-${index}`,
        })),
        apiConversation,
        uiMessage,
        updateTaskHistory: persistTaskHistory,
        setCheckpointTracker: vi.fn(),
    }
    const manager = createTaskCheckpointManager(
        {
            taskId: "task-1",
            controller: { task: { resumeTask } },
        } as never,
        { enableCheckpoints: true },
        {
            fileContextTracker: { detectFilesEditedAfterMessage: vi.fn().mockResolvedValue([]) },
            contextManager: { truncateContextHistory },
            diffViewProvider: {},
            messageStateHandler,
            taskState,
            ...(conversationRewind === undefined ? {} : { conversationRewind }),
            ...(canonicalCheckpoint === undefined ? {} : { canonicalCheckpoint }),
            ...(trackedFiles === undefined
                ? {}
                : {
                      taskFileTracker: {
                          getAllModifiedFiles: vi.fn().mockReturnValue(trackedFiles),
                          markWorkspaceScanRequired: vi.fn(),
                          notePendingChange: vi.fn(),
                          hasPendingChanges: vi.fn().mockReturnValue(true),
                      },
                  }),
            ...(workspacePath
                ? {
                      workspaceManager: {
                          getPrimaryRoot: () => ({ path: workspacePath }),
                          getRoots: () => [{ path: workspacePath }],
                      },
                  }
                : {}),
        } as never,
        {
            updateTaskHistory: vi.fn().mockResolvedValue([]),
            cancelTask: vi.fn().mockResolvedValue(undefined),
            restoreChatRuntime,
            say: vi.fn().mockResolvedValue(100),
            postStateToWebview,
            publishMessage: vi.fn().mockResolvedValue(undefined),
        } as never,
        {
            checkpointTracker: { getDiffSet, resetHead, restoreFiles } as never,
        },
    )
    return {
        manager,
        taskState,
        resetHead,
        restoreFiles,
        closeAllDiffs,
        getDiffSet,
        restoreChatRuntime,
        resumeTask,
        persistTaskHistory,
        postStateToWebview,
        truncateContextHistory,
        truncateApiHistory,
        truncateUiHistory,
        clearTransientClineMessages,
    }
}

describe("TaskCheckpointManager restore isolation", () => {
    it("restores workspace files without clearing active chat state", async () => {
        const harness = createHarness([{ ts: 42, type: "say", say: "checkpoint_created", lastCheckpointHash: ["hash-1"] }])

        await harness.manager.restoreCheckpoint(42, "workspace")

        expect(harness.closeAllDiffs).toHaveBeenCalledOnce()
        expect(harness.resetHead).toHaveBeenCalledWith("hash-1")
        expect(harness.closeAllDiffs.mock.invocationCallOrder[0]).toBeLessThan(harness.resetHead.mock.invocationCallOrder[0])
        expect(harness.taskState).toMatchObject({
            userMessageContent: [{ type: "text", text: "active user content" }],
            assistantMessageContent: [{ type: "text", text: "active assistant content" }],
            userMessageContentReady: true,
            lastMessageTs: 99,
            consecutiveMistakeCount: 3,
            consecutiveIdenticalToolCount: 4,
            lastToolName: "replace_in_file",
            lastToolParams: "stale-params",
        })
        expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
        expect(harness.resumeTask).not.toHaveBeenCalled()
        // A file-only restore must not touch conversation presentation state.
        expect(harness.clearTransientClineMessages).not.toHaveBeenCalled()
    })

    it("keeps file restore available after restoring only the task conversation", async () => {
        const checkpoint: UiMessage = {
            ts: 42,
            type: "say",
            say: "checkpoint_created",
            conversationHistoryIndex: 0,
            lastCheckpointHash: ["hash-1"],
        }
        const harness = createHarness([checkpoint, { ts: 43, type: "say", say: "text", text: "later" }])

        await harness.manager.restoreCheckpoint(42, "task")

        expect(checkpoint.lastCheckpointHash).toEqual(["hash-1"])
        expect(harness.resetHead).not.toHaveBeenCalled()

        await harness.manager.restoreCheckpoint(42, "workspace")

        expect(harness.resetHead).toHaveBeenCalledWith("hash-1")
    })

    it("rejects a workspace restore whose effective delta is empty", async () => {
        const harness = createHarness([{ ts: 42, type: "say", say: "checkpoint_created", lastCheckpointHash: ["hash-1"] }])
        harness.getDiffSet.mockResolvedValue([])

        const result = await harness.manager.restoreCheckpoint(42, "workspace")

        expect(harness.resetHead).not.toHaveBeenCalled()
        expect(harness.restoreFiles).not.toHaveBeenCalled()
        expect(result.checkpointManagerErrorMessage).toBe("No workspace changes to restore")
    })

    it("resolves a current single root by persisted identity instead of the first hash", async () => {
        const rootA = path.resolve("C:/workspace-a")
        const rootB = path.resolve("C:/workspace-b")
        const harness = createHarness(
            [
                {
                    ts: 42,
                    type: "say",
                    say: "checkpoint_created",
                    lastCheckpointHash: ["hash-a", "hash-b"],
                    checkpointWorkspaceRoots: [rootA, rootB],
                },
            ],
            undefined,
            2,
            undefined,
            undefined,
            rootB,
        )

        await harness.manager.restoreCheckpoint(42, "workspace")

        expect(harness.resetHead).toHaveBeenCalledWith("hash-b")
    })

    it("truncates a durable compaction failure card that follows the restore point", async () => {
        // A failed compaction carries no compactionConversationRange, so it is an ordinary
        // durable row. Restoring an earlier point must rewind past it and remove it.
        const failureCard: UiMessage = {
            ts: 43,
            type: "say",
            say: "tool",
            partial: false,
            conversationHistoryIndex: 1,
            text: JSON.stringify({
                tool: "summarizeTask",
                content: "",
                compactionStatus: "failed",
                compactionUnitKind: "failure",
                error: "Internal compaction Pass did not return a valid summarize_task context",
            }),
        } as UiMessage
        const harness = createHarness([
            { ts: 42, type: "say", say: "checkpoint_created", lastCheckpointHash: ["hash-1"] },
            failureCard,
        ])

        await harness.manager.restoreCheckpoint(42, "task")

        // uiKeepCount stops at the restored checkpoint row, so the failure card is dropped.
        expect(harness.truncateUiHistory).toHaveBeenCalledWith(1)
    })

    it("drops transient presentation overlays before resolving the chat boundary", async () => {
        const harness = createHarness([
            { ts: 42, type: "say", say: "checkpoint_created", lastCheckpointHash: ["hash-1"] },
            { ts: 43, type: "say", say: "text", text: "later" },
        ])

        await harness.manager.restoreCheckpoint(42, "task")

        expect(harness.clearTransientClineMessages).toHaveBeenCalledOnce()
        expect(harness.clearTransientClineMessages.mock.invocationCallOrder[0]).toBeLessThan(
            harness.truncateUiHistory.mock.invocationCallOrder[0],
        )
    })

    it("restores only files owned by the active task when file tracking is available", async () => {
        const taskFiles = ["e:/workspace/panel-a-checkpoint.txt"]
        const harness = createHarness(
            [{ ts: 42, type: "say", say: "checkpoint_created", lastCheckpointHash: ["hash-1"] }],
            taskFiles,
        )

        await harness.manager.restoreCheckpoint(42, "workspace")

        expect(harness.restoreFiles).toHaveBeenCalledWith("hash-1", taskFiles)
        expect(harness.resetHead).not.toHaveBeenCalled()
    })

    it("does not pass external lifetime task paths to workspace restore", async () => {
        const workspacePath = path.resolve("C:/workspace")
        const insideFile = path.join(workspacePath, "inside.ts")
        const outsideFile = path.resolve("C:/outside", "outside.ts")
        const harness = createHarness(
            [{ ts: 42, type: "say", say: "checkpoint_created", lastCheckpointHash: ["hash-1"] }],
            [insideFile, outsideFile],
            2,
            undefined,
            undefined,
            workspacePath,
        )

        await harness.manager.restoreCheckpoint(42, "workspace")

        expect(harness.restoreFiles).toHaveBeenCalledWith("hash-1", [insideFile])
        expect(harness.restoreFiles).not.toHaveBeenCalledWith("hash-1", expect.arrayContaining([outsideFile]))
    })

    it("restores chat into a canonical paused runtime without auto-resuming", async () => {
        const harness = createHarness([
            { ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
            { ts: 43, type: "say", say: "text" },
        ])

        await harness.manager.restoreCheckpoint(42, "task")

        expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 1 })
        expect(harness.resumeTask).not.toHaveBeenCalled()
        expect(harness.truncateContextHistory).toHaveBeenCalledWith(42, expect.any(String))
    })

    it("clears mistake-limit detector state when restoring chat", async () => {
        const harness = createHarness([
            { ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
            { ts: 43, type: "say", say: "text" },
        ])

        await harness.manager.restoreCheckpoint(42, "task")

        expect(harness.taskState).toMatchObject({
            consecutiveMistakeCount: 0,
            consecutiveIdenticalToolCount: 0,
            lastToolName: "",
            lastToolParams: "",
        })
    })

    it("restores chat and workspace through one combined success projection", async () => {
        const messages: UiMessage[] = [
            {
                ts: 42,
                type: "say",
                say: "checkpoint_created",
                conversationHistoryIndex: 0,
                lastCheckpointHash: ["hash-1"],
            },
            { ts: 43, type: "say", say: "text" },
        ]
        const harness = createHarness(messages)

        await harness.manager.restoreCheckpoint(42, "taskAndWorkspace")

        expect(harness.resetHead).toHaveBeenCalledOnce()
        expect(harness.resetHead).toHaveBeenCalledWith("hash-1")
        expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
        expect(messages[0]?.isCheckpointCheckedOut).toBe(true)
        expect(harness.persistTaskHistory).toHaveBeenCalledOnce()
        expect(harness.postStateToWebview).toHaveBeenCalledOnce()
    })

    it("uses the preceding file checkpoint while restoring the selected chat point", async () => {
        const harness = createHarness([
            { ts: 41, type: "say", say: "checkpoint_created", lastCheckpointHash: ["fallback-hash"] },
            { ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
            { ts: 43, type: "say", say: "text" },
        ])

        await harness.manager.restoreCheckpoint(42, "taskAndWorkspace")

        expect(harness.resetHead).toHaveBeenCalledWith("fallback-hash")
        expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
    })

    it("restores chat when a combined restore has no file checkpoint hash", async () => {
        const harness = createHarness([
            { ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
            { ts: 43, type: "say", say: "text" },
        ])

        const result = await harness.manager.restoreCheckpoint(42, "taskAndWorkspace")

        expect(harness.resetHead).not.toHaveBeenCalled()
        expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
        expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 1 })
        expect(result.checkpointManagerErrorMessage).toBe("Failed to restore checkpoint: No valid checkpoint hash found")
        expect(harness.persistTaskHistory).toHaveBeenCalledOnce()
        expect(harness.postStateToWebview).toHaveBeenCalledOnce()
    })

    it("restores chat when resetting workspace files fails", async () => {
        const harness = createHarness([
            {
                ts: 42,
                type: "say",
                say: "checkpoint_created",
                conversationHistoryIndex: 0,
                lastCheckpointHash: ["hash-1"],
            },
            { ts: 43, type: "say", say: "text" },
        ])
        harness.resetHead.mockRejectedValueOnce(new Error("reset failed"))

        const result = await harness.manager.restoreCheckpoint(42, "taskAndWorkspace")

        expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
        expect(result.checkpointManagerErrorMessage).toBe("Failed to restore checkpoint: reset failed")
    })

    it("keeps chat untouched when a workspace-only restore has no hash", async () => {
        const harness = createHarness([{ ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 }])

        const result = await harness.manager.restoreCheckpoint(42, "workspace")

        expect(harness.resetHead).not.toHaveBeenCalled()
        expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
        expect(harness.taskState).toMatchObject({
            userMessageContent: [{ type: "text", text: "active user content" }],
            assistantMessageContent: [{ type: "text", text: "active assistant content" }],
            userMessageContentReady: true,
            lastMessageTs: 99,
        })
        expect(harness.persistTaskHistory).not.toHaveBeenCalled()
        expect(harness.postStateToWebview).not.toHaveBeenCalled()
        expect(result.checkpointManagerErrorMessage).toBe("Failed to restore checkpoint: No valid checkpoint hash found")
    })

    it("restores a completed compaction card to its pre-compaction boundary through the ordinary transaction", async () => {
        const messages: UiMessage[] = [
            { ts: 10, type: "say", say: "task", conversationHistoryIndex: 0 },
            { ts: 20, type: "say", say: "text", conversationHistoryIndex: 1 },
            {
                ts: 30,
                type: "say",
                say: "tool",
                conversationHistoryIndex: 3,
                conversationHistoryDeletedRange: [0, 1],
                compactionConversationRange: {
                    logicalTurnRange: [0, 1],
                    apiConversationRange: [0, 2],
                    preCompactionApiEndIndex: 3,
                },
                text: JSON.stringify({ tool: "summarizeTask", content: "summary", compactionStatus: "completed" }),
            },
            { ts: 40, type: "say", say: "text", conversationHistoryIndex: 4 },
        ]
        const harness = createHarness(messages, undefined, 5)

        await harness.manager.restoreCheckpoint(30, "task")

        expect(harness.truncateApiHistory).toHaveBeenCalledOnce()
        expect(harness.truncateApiHistory).toHaveBeenCalledWith(4)
        expect(harness.truncateUiHistory).toHaveBeenCalledOnce()
        expect(harness.truncateUiHistory).toHaveBeenCalledWith(2)
        expect(harness.truncateContextHistory).toHaveBeenCalledWith(20, expect.any(String))
        expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
        expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 3 })
        expect(harness.taskState.conversationHistoryDeletedRange).toEqual([0, 1])
        expect(harness.resetHead).not.toHaveBeenCalled()
    })

    it("rejects an invalid compaction boundary before mutating API, UI, context, or runtime", async () => {
        const messages: UiMessage[] = [
            { ts: 10, type: "say", say: "task", conversationHistoryIndex: 0 },
            {
                ts: 30,
                type: "say",
                say: "tool",
                conversationHistoryIndex: 8,
                compactionConversationRange: {
                    logicalTurnRange: [0, 0],
                    apiConversationRange: [0, 1],
                    preCompactionApiEndIndex: 8,
                },
                text: JSON.stringify({ tool: "summarizeTask", content: "summary", compactionStatus: "completed" }),
            },
        ]
        const harness = createHarness(messages, undefined, 3)

        const result = await harness.manager.restoreCheckpoint(30, "task")

        expect(result.checkpointManagerErrorMessage).toMatch(/inconsistent with the current conversation/)
        expect(harness.truncateApiHistory).not.toHaveBeenCalled()
        expect(harness.truncateUiHistory).not.toHaveBeenCalled()
        expect(harness.truncateContextHistory).not.toHaveBeenCalled()
        expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
        expect(harness.persistTaskHistory).not.toHaveBeenCalled()
    })

    describe("journal-bounded compaction card", () => {
        const journalMessages = (): UiMessage[] => [
            { ts: 10, type: "say", say: "task" },
            { ts: 20, type: "say", say: "text" },
            {
                ts: 30,
                type: "say",
                say: "tool",
                partial: false,
                text: JSON.stringify({
                    tool: "summarizeTask",
                    content: "summary",
                    compactionStatus: "completed",
                    compactionJournalBoundary: { seq: 6 },
                }),
            },
            { ts: 40, type: "say", say: "text" },
        ]

        it("rewinds the journal before any chat or context file is truncated", async () => {
            const order: string[] = []
            const rewindTo = vi.fn(async () => {
                order.push("rewind")
            })
            const harness = createHarness(journalMessages(), undefined, 2, { rewindTo })
            harness.truncateUiHistory.mockImplementation(async () => {
                order.push("ui")
            })

            await harness.manager.restoreCheckpoint(30, "task")

            expect(rewindTo).toHaveBeenCalledWith({ operationId: "checkpoint.restore:30", target: { seq: 6 } })
            expect(order).toEqual(["rewind", "ui"])
            expect(harness.truncateUiHistory).toHaveBeenCalledWith(2)
            expect(harness.truncateContextHistory).toHaveBeenCalledWith(20, expect.any(String))
            expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
        })

        it("leaves every store untouched when the journal refuses the rewind", async () => {
            const rewindTo = vi.fn().mockRejectedValue(new Error("ConversationRewindTargetMissing"))
            const harness = createHarness(journalMessages(), undefined, 2, { rewindTo })

            const result = await harness.manager.restoreCheckpoint(30, "task")

            expect(result.checkpointManagerErrorMessage).toBe("ConversationRewindTargetMissing")
            expect(harness.truncateApiHistory).not.toHaveBeenCalled()
            expect(harness.truncateUiHistory).not.toHaveBeenCalled()
            expect(harness.truncateContextHistory).not.toHaveBeenCalled()
            expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
        })

        it("refuses the restore when no journal is available to rewind", async () => {
            const harness = createHarness(journalMessages(), undefined, 2)

            const result = await harness.manager.restoreCheckpoint(30, "task")

            expect(result.checkpointManagerErrorMessage).toMatch(/requires the task conversation journal/)
            expect(harness.truncateUiHistory).not.toHaveBeenCalled()
            expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
        })

        it("refuses a task-and-workspace restore before rewinding files when no journal is available", async () => {
            const messages = journalMessages()
            messages[2] = { ...messages[2], lastCheckpointHash: ["hash-card"] }
            const harness = createHarness(messages, undefined, 2)

            const result = await harness.manager.restoreCheckpoint(30, "taskAndWorkspace")

            expect(result.checkpointManagerErrorMessage).toMatch(/requires the task conversation journal/)
            expect(harness.resetHead).not.toHaveBeenCalled()
            expect(harness.restoreFiles).not.toHaveBeenCalled()
            expect(harness.truncateUiHistory).not.toHaveBeenCalled()
            expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
        })

        it("refuses to edit a journal-bounded card before rewinding files", async () => {
            const rewindTo = vi.fn().mockResolvedValue(undefined)
            const messages = journalMessages()
            messages[2] = { ...messages[2], lastCheckpointHash: ["hash-card"] }
            const harness = createHarness(messages, undefined, 2, { rewindTo })

            const result = await harness.manager.restoreCheckpoint(30, "taskAndWorkspace", undefined, "edited")

            expect(result.checkpointManagerErrorMessage).toMatch(/Editing input is unavailable/)
            expect(harness.resetHead).not.toHaveBeenCalled()
            expect(rewindTo).not.toHaveBeenCalled()
        })

        it("restores the card through the canonical transaction at the position before the compaction", async () => {
            const rewindTo = vi.fn()
            const canonicalRestore = vi.fn(async () => ({ kind: "restored" as const, diagnostics: [] }))
            const harness = createHarness(
                journalMessages(),
                undefined,
                2,
                { rewindTo },
                { capture: vi.fn(), restore: canonicalRestore },
            )

            const result = await harness.manager.restoreCheckpoint(30, "task")

            expect(result.checkpointManagerErrorMessage).toBeUndefined()
            expect(canonicalRestore).toHaveBeenCalledWith(
                expect.objectContaining({ messageTs: 30, mode: "chat_only", journalTarget: { seq: 6 } }),
            )
            // The transaction rewinds the journal itself; the manager only drops the card and what follows.
            expect(rewindTo).not.toHaveBeenCalled()
            expect(harness.truncateUiHistory).toHaveBeenCalledWith(2)
            expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
        })

        it("reports a failed canonical restore instead of throwing, with nothing truncated", async () => {
            const canonicalRestore = vi.fn().mockRejectedValue(new Error("CanonicalCheckpointBoundaryAhead"))
            const harness = createHarness(
                journalMessages(),
                undefined,
                2,
                { rewindTo: vi.fn() },
                { capture: vi.fn(), restore: canonicalRestore },
            )

            const result = await harness.manager.restoreCheckpoint(30, "task")

            expect(result.checkpointManagerErrorMessage).toBe("CanonicalCheckpointBoundaryAhead")
            expect(harness.truncateUiHistory).not.toHaveBeenCalled()
            expect(harness.truncateContextHistory).not.toHaveBeenCalled()
            expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
        })
    })

    it("uses the canonical transaction before clearing legacy presentation state", async () => {
        const order: string[] = []
        const canonicalRestore = vi.fn(async () => {
            order.push("canonical")
            return { kind: "restored" as const, diagnostics: [] }
        })
        const harness = createHarness(
            [
                { ts: 42, type: "say", say: "checkpoint_created", conversationHistoryIndex: 0 },
                { ts: 43, type: "say", say: "text" },
            ],
            undefined,
            2,
            { rewindTo: vi.fn() },
            { capture: vi.fn(), restore: canonicalRestore },
        )
        harness.clearTransientClineMessages.mockImplementation(() => {
            order.push("clear-transient")
            return []
        })

        await harness.manager.restoreCheckpoint(42, "task")

        expect(canonicalRestore).toHaveBeenCalledWith(
            expect.objectContaining({ messageTs: 42, mode: "chat_only", restoreWorkspace: expect.any(Function) }),
        )
        expect(order).toEqual(["canonical", "clear-transient"])
        expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 1 })
    })

    it("restores a pre-edit row's files with the chat of the checkpoint it is anchored to", async () => {
        const canonicalRestore = vi.fn(async () => ({ kind: "restored" as const, diagnostics: [] }))
        const harness = createHarness(
            [
                { ts: 42, type: "say", say: "checkpoint_created", conversationHistoryIndex: 0, conversationJournalSeq: 7 },
                { ts: 43, type: "say", say: "text" },
                {
                    ts: 44,
                    type: "say",
                    say: "checkpoint_created",
                    checkpointAnchorTs: 42,
                    conversationHistoryIndex: 0,
                    conversationJournalSeq: 7,
                    lastCheckpointHash: ["pre-edit-hash"],
                },
                { ts: 45, type: "say", say: "tool" },
            ],
            undefined,
            2,
            { rewindTo: vi.fn() },
            { capture: vi.fn(), restore: canonicalRestore },
        )

        await harness.manager.restoreCheckpoint(44, "taskAndWorkspace")

        // The clicked row's bundle holds its own files and the anchor's conversation;
        // without that bundle the row's own position and files still restore it.
        expect(canonicalRestore).toHaveBeenCalledWith(
            expect.objectContaining({
                messageTs: 44,
                mode: "combined",
                fallback: { journalTarget: { seq: 7 }, workspaceRef: "pre-edit-hash" },
            }),
        )
        // The chat is cut right after the anchor, so the round's later rows go with it.
        expect(harness.truncateUiHistory).toHaveBeenCalledWith(1)
    })

    it("refuses a pre-edit row whose anchor is no longer in the chat", async () => {
        const canonicalRestore = vi.fn()
        const harness = createHarness(
            [{ ts: 44, type: "say", say: "checkpoint_created", checkpointAnchorTs: 42, lastCheckpointHash: ["pre-edit-hash"] }],
            undefined,
            2,
            { rewindTo: vi.fn() },
            { capture: vi.fn(), restore: canonicalRestore },
        )

        const update = await harness.manager.restoreCheckpoint(44, "task")

        expect(update.checkpointManagerErrorMessage).toContain("anchor")
        expect(canonicalRestore).not.toHaveBeenCalled()
    })

    it("leaves legacy stores untouched when canonical validation rejects the restore", async () => {
        const canonicalRestore = vi.fn(async () => ({
            kind: "rejected" as const,
            diagnostics: [{ code: "canonical_missing", message: "checkpoint bundle missing" }],
        }))
        const harness = createHarness(
            [
                { ts: 42, type: "say", say: "checkpoint_created", conversationHistoryIndex: 0 },
                { ts: 43, type: "say", say: "text" },
            ],
            undefined,
            2,
            { rewindTo: vi.fn() },
            { capture: vi.fn(), restore: canonicalRestore },
        )

        const result = await harness.manager.restoreCheckpoint(42, "task")

        expect(result.checkpointManagerErrorMessage).toBe("checkpoint bundle missing")
        expect(harness.clearTransientClineMessages).not.toHaveBeenCalled()
        expect(harness.truncateUiHistory).not.toHaveBeenCalled()
        expect(harness.truncateContextHistory).not.toHaveBeenCalled()
        expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
    })

    it("continues an edited chat restore exactly once through the typed runtime", async () => {
        const harness = createHarness([
            { ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
            { ts: 43, type: "say", say: "text" },
        ])

        await harness.manager.restoreCheckpoint(42, "task", undefined, "edited input")

        expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
        expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 1, editedText: "edited input" })
        expect(harness.resetHead).not.toHaveBeenCalled()
        expect(harness.resumeTask).not.toHaveBeenCalled()
    })
})
