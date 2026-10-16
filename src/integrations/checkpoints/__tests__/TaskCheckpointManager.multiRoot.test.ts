import type CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { VcsType } from "@shared/multi-root/types"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import { DefaultToolHandlerState } from "@/core/task/tools/state/ToolHandlerState"
import type { UiMessage, UiSay } from "@/shared/ExtensionMessage"

vi.unmock("@integrations/checkpoints")

import { type CheckpointRowFields, createTaskCheckpointManager } from "../index"

function createHarness(
    createCheckpointTracker: (taskId: string, enabled: boolean, root: string) => Promise<CheckpointTracker | undefined>,
) {
    const rootA = path.resolve("C:/workspace-a")
    const rootB = path.resolve("C:/workspace-b")
    const messages: UiMessage[] = []
    const taskState = new DefaultToolHandlerState()
    const restoreChatRuntime = vi.fn().mockResolvedValue(undefined)
    let nextMessageTs = 42
    const updateClineMessage = vi.fn(async (index: number, updates: Partial<UiMessage>) =>
        Object.assign(messages[index], updates),
    )
    const manager = createTaskCheckpointManager(
        { taskId: "task-multi-root", controller: {} } as never,
        { enableCheckpoints: true, createCheckpointTracker },
        {
            fileContextTracker: {
                detectFilesEditedAfterMessage: vi.fn().mockResolvedValue([]),
                storePendingFileContextWarning: vi.fn().mockResolvedValue(undefined),
            },
            contextManager: { truncateContextHistory: vi.fn().mockResolvedValue(undefined) },
            diffViewProvider: {},
            messageStateHandler: {
                clineMessages: messages,
                durableClineMessages: messages,
                clearTransientClineMessages: vi.fn(),
                apiConversation: {
                    count: 1,
                    getAt: vi.fn(),
                    truncateByLineNum: vi.fn().mockResolvedValue(undefined),
                },
                uiMessage: {
                    get count() {
                        return messages.length
                    },
                    truncateByLineNum: vi.fn().mockResolvedValue(undefined),
                },
                invalidateDerivedAggregates: vi.fn(),
                setCheckpointTracker: vi.fn(),
                updateClineMessage,
                flushMessageUpdate: vi.fn().mockResolvedValue(undefined),
                updateTaskHistory: vi.fn().mockResolvedValue(undefined),
            },
            taskState,
            taskFileTracker: {
                getModifiedFiles: vi.fn().mockReturnValue([]),
                getAllModifiedFiles: vi.fn().mockReturnValue([]),
                getObservedFiles: vi.fn().mockReturnValue([]),
                isWorkspaceScanRequired: vi.fn().mockReturnValue(false),
                isScanAttributedToTask: vi.fn().mockReturnValue(false),
                markWorkspaceScanRequired: vi.fn(),
                notePendingChange: vi.fn(),
                hasPendingChanges: vi.fn().mockReturnValue(true),
                pendingWatermark: vi.fn().mockReturnValue(0),
                settlePending: vi.fn(),
                dropModifiedFiles: vi.fn(),
                clearWorkspaceScanRequired: vi.fn(),
            },
            workspaceManager: {
                getRoots: () => [
                    { path: rootA, name: "a", vcs: VcsType.None },
                    { path: rootB, name: "b", vcs: VcsType.None },
                ],
                getPrimaryIndex: () => 0,
                getPrimaryRoot: () => ({ path: rootA, name: "a", vcs: VcsType.None }),
            },
        } as never,
        {
            updateTaskHistory: vi.fn(),
            cancelTask: vi.fn(),
            restoreChatRuntime,
            say: vi.fn(async (say: UiSay) => {
                const message: UiMessage = { ts: nextMessageTs++, type: "say", say }
                messages.push(message)
                return message.ts
            }),
            beginRow: vi.fn((fields: CheckpointRowFields) => {
                const message: UiMessage = { ts: nextMessageTs++, type: "say", say: "checkpoint_created", ...fields }
                messages.push(message)
                return { ts: message.ts, persistence: Promise.resolve(message) }
            }),
            postStateToWebview: vi.fn().mockResolvedValue(undefined),
        } as never,
        {},
    )
    return { manager, messages, rootA, rootB, taskState, updateClineMessage, restoreChatRuntime }
}

function tracker(hash: string): CheckpointTracker {
    return {
        commitForFiles: vi.fn().mockResolvedValueOnce(hash).mockResolvedValue(`${hash}-next`),
        restoreFiles: vi.fn().mockResolvedValue(undefined),
        resetHead: vi.fn().mockResolvedValue(undefined),
        getDiffSet: vi
            .fn()
            .mockResolvedValue([
                { relativePath: "changed.ts", absolutePath: path.resolve("C:/changed.ts"), before: "before", after: "after" },
            ]),
        getTaskDiffSet: vi.fn().mockResolvedValue([]),
        getTaskDiffCount: vi.fn().mockResolvedValue(0),
        getConsecutiveStagingFailures: vi.fn().mockReturnValue(0),
    } as unknown as CheckpointTracker
}

async function sealLatestTurn(harness: ReturnType<typeof createHarness>): Promise<void> {
    await harness.manager.saveCheckpoint()
    const completion: UiMessage = { ts: 900, type: "say", say: "completion_result" }
    harness.messages.push(completion)
    await harness.manager.saveCheckpoint(true, completion.ts)
    harness.messages.pop()
}

describe("TaskCheckpointManager multi-root", () => {
    it("keeps a restorable chat checkpoint when every workspace tracker fails", async () => {
        const create = vi.fn().mockRejectedValue(new Error("Git must be installed to use checkpoints."))
        const harness = createHarness(create)

        await harness.manager.saveCheckpoint()
        await harness.manager.restoreCheckpoint(42, "task")

        expect(create).toHaveBeenCalledTimes(2)
        expect(harness.messages[0]).toEqual(expect.objectContaining({ say: "checkpoint_created" }))
        expect(harness.messages[0]).not.toHaveProperty("lastCheckpointHash")
        expect(harness.taskState.checkpointManagerErrorMessage).toContain("Git must be installed")
        expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 0 })
    })

    it("persists every root revision instead of discarding secondary roots", async () => {
        const harness = createHarness(async (_taskId, _enabled, workspacePath) =>
            workspacePath === path.resolve("C:/workspace-a") ? tracker("hash-a") : tracker("hash-b"),
        )

        await sealLatestTurn(harness)

        expect(harness.messages[0]).toEqual(
            expect.objectContaining({
                lastCheckpointHash: ["hash-a", "hash-b"],
                checkpointWorkspaceRoots: [harness.rootA, harness.rootB],
            }),
        )
        expect(harness.updateClineMessage).toHaveBeenCalledWith(1, {
            lastCheckpointHash: ["hash-a-next", "hash-b-next"],
            checkpointWorkspaceRoots: [harness.rootA, harness.rootB],
        })
    })

    it("returns Task-owned changes across every referenced workspace root", async () => {
        const trackerA = tracker("hash-a1")
        const trackerB = tracker("hash-b1")
        vi.mocked(trackerA.getTaskDiffSet).mockResolvedValue([
            { relativePath: "a.ts", absolutePath: path.join("C:/workspace-a", "a.ts"), before: "a0", after: "a1" },
        ])
        vi.mocked(trackerB.getTaskDiffSet).mockResolvedValue([
            { relativePath: "b.ts", absolutePath: path.join("C:/workspace-b", "b.ts"), before: "b0", after: "b1" },
        ])
        const harness = createHarness(async (_taskId, _enabled, workspacePath) =>
            workspacePath === path.resolve("C:/workspace-a") ? trackerA : trackerB,
        )
        await sealLatestTurn(harness)
        harness.messages.push({
            ts: 43,
            type: "say",
            say: "completion_result",
            lastCheckpointHash: ["hash-a2", "hash-b2"],
            checkpointWorkspaceRoots: [harness.rootA, harness.rootB],
        })

        const changedFiles = await harness.manager.getTaskChangesForCheckpoint(43)

        expect(changedFiles.map((file) => file.relativePath)).toEqual(["a.ts", "b.ts"])
        expect(trackerA.getTaskDiffSet).toHaveBeenCalledWith("hash-a1", "hash-a2")
        expect(trackerB.getTaskDiffSet).toHaveBeenCalledWith("hash-b1", "hash-b2")
    })

    it("keeps a positive completion verdict when another root diff fails", async () => {
        const trackerA = tracker("hash-a1")
        const trackerB = tracker("hash-b1")
        vi.mocked(trackerA.getTaskDiffCount).mockResolvedValue(1)
        vi.mocked(trackerB.getTaskDiffCount).mockRejectedValue(new Error("secondary diff failed"))
        const harness = createHarness(async (_taskId, _enabled, workspacePath) =>
            workspacePath === path.resolve("C:/workspace-a") ? trackerA : trackerB,
        )
        await sealLatestTurn(harness)
        harness.messages.push({
            ts: 43,
            type: "say",
            say: "completion_result",
            lastCheckpointHash: ["hash-a2", "hash-b2"],
            checkpointWorkspaceRoots: [harness.rootA, harness.rootB],
        })

        await expect(harness.manager.doesLatestTaskCompletionHaveNewChanges()).resolves.toBe(true)
    })

    it("restores every referenced workspace root", async () => {
        const trackerA = tracker("hash-a")
        const trackerB = tracker("hash-b")
        const harness = createHarness(async (_taskId, _enabled, workspacePath) =>
            workspacePath === path.resolve("C:/workspace-a") ? trackerA : trackerB,
        )
        await sealLatestTurn(harness)

        await harness.manager.restoreCheckpoint(42, "workspace")

        expect(trackerA.resetHead).toHaveBeenCalledWith("hash-a")
        expect(trackerB.resetHead).toHaveBeenCalledWith("hash-b")
    })

    it("restores chat but does not mark a partial file restore as fully checked out", async () => {
        const trackerA = tracker("hash-a")
        const trackerB = tracker("hash-b")
        const harness = createHarness(async (_taskId, _enabled, workspacePath) =>
            workspacePath === path.resolve("C:/workspace-a") ? trackerA : trackerB,
        )
        await sealLatestTurn(harness)
        vi.mocked(trackerB.resetHead).mockRejectedValueOnce(new Error("secondary restore failed"))

        await harness.manager.restoreCheckpoint(42, "taskAndWorkspace")

        expect(trackerA.resetHead).toHaveBeenCalledWith("hash-a")
        expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 0 })
        expect(harness.messages[0]?.isCheckpointCheckedOut).toBe(false)
    })
})
