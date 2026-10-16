import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { ensureCheckpointInitialized } from "@integrations/checkpoints/initializer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { closeInstanceStoragesUnder } from "@/core/storage/instance"
import { UIMessage } from "@/core/storage/UIMessage"
import { MessageStateHandler } from "@/core/task/message-state"
import { DefaultToolHandlerState } from "@/core/task/tools/state/ToolHandlerState"
import type { UiMessage } from "@/shared/ExtensionMessage"

vi.unmock("@integrations/checkpoints")

import { createCheckpointReferenceSet } from "@shared/checkpoints"
import { encodeCheckpointWorkspaceRef } from "../checkpoint-references"
import { type CheckpointRowFields, createTaskCheckpointManager } from "../index"
import type { CanonicalCheckpointPort } from "../types"

/** The canonical reference a single-root workspace binds to its shadow commit. */
function singleRootWorkspaceRef(hash: string): string {
    return encodeCheckpointWorkspaceRef(createCheckpointReferenceSet([hash], ["C:/workspace"]))
}

type CreateCheckpointTracker = (
    taskId: string,
    enableCheckpoints: boolean,
    workspacePath: string,
) => Promise<CheckpointTracker | undefined>

function createManager(
    createCheckpointTracker: CreateCheckpointTracker,
    initialError?: string,
    options?: { messages?: UiMessage[]; tracker?: CheckpointTracker; canonicalCheckpoint?: CanonicalCheckpointPort },
) {
    const messages = options?.messages ?? []
    const taskState: { taskId: string; checkpointManagerErrorMessage?: string } = {
        taskId: "task-1",
        ...(initialError === undefined ? {} : { checkpointManagerErrorMessage: initialError }),
    }
    const setCheckpointTracker = vi.fn()
    const postStateToWebview = vi.fn().mockResolvedValue(undefined)
    const say = vi.fn(async () => undefined)
    let nextRowTs = 41
    const beginRow = vi.fn((fields: CheckpointRowFields) => {
        const message: UiMessage = { ts: ++nextRowTs, type: "say", say: "checkpoint_created", ...fields }
        messages.push(message)
        return { ts: message.ts, persistence: Promise.resolve(message) }
    })
    const updateClineMessage = vi.fn(async (index: number, updates: Partial<UiMessage>) => {
        Object.assign(messages[index], updates)
    })
    const flushMessageUpdate = vi.fn().mockResolvedValue(undefined)
    const publishMessage = vi.fn(async (_message: UiMessage) => undefined)
    const manager = createTaskCheckpointManager(
        { taskId: "task-1", controller: {} } as never,
        { enableCheckpoints: true, createCheckpointTracker },
        {
            fileContextTracker: {},
            diffViewProvider: {},
            messageStateHandler: {
                clineMessages: messages,
                setCheckpointTracker,
                updateClineMessage,
                flushMessageUpdate,
                updateTaskHistory: vi.fn().mockResolvedValue(undefined),
            },
            taskState,
            workspaceManager: { getPrimaryRoot: () => ({ path: "C:/workspace" }) },
            ...(options?.canonicalCheckpoint ? { canonicalCheckpoint: options.canonicalCheckpoint } : {}),
        } as never,
        {
            updateTaskHistory: vi.fn(),
            cancelTask: vi.fn(),
            restoreChatRuntime: vi.fn(),
            say,
            beginRow,
            postStateToWebview,
            publishMessage,
        } as never,
        {
            checkpointManagerErrorMessage: initialError,
            ...(options?.tracker ? { checkpointTracker: options.tracker } : {}),
        },
    )
    return {
        manager,
        beginRow,
        taskState,
        setCheckpointTracker,
        postStateToWebview,
        publishMessage,
        updateClineMessage,
        flushMessageUpdate,
    }
}

describe("TaskCheckpointManager checkpoint initialization", () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it("retries a transient shadow initialization failure and clears the projected error", async () => {
        const tracker = { setTaskFileTracker: vi.fn() } as never
        const create = vi
            .fn<CreateCheckpointTracker>()
            .mockRejectedValueOnce(new Error("EBUSY: shadow index is locked"))
            .mockResolvedValueOnce(tracker)
        const harness = createManager(create, "Previous checkpoint initialization failed")

        const result = await harness.manager.retryCheckpointInitialization()

        expect(result).toBe(true)
        expect(create).toHaveBeenCalledTimes(2)
        expect(harness.setCheckpointTracker).toHaveBeenCalledWith(tracker)
        expect(harness.taskState.checkpointManagerErrorMessage).toBeUndefined()
        expect(harness.postStateToWebview).toHaveBeenCalled()
    })

    it("uses a 120 second total initialization budget by default", async () => {
        vi.useFakeTimers()
        try {
            const checkpointManager = {
                checkpointTrackerCheckAndInit: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 90_000))),
            } as never
            const initialization = expect(ensureCheckpointInitialized({ checkpointManager })).resolves.toBeUndefined()

            await vi.advanceTimersByTimeAsync(90_000)

            await initialization
        } finally {
            vi.useRealTimers()
        }
    })

    it("allows a slow shadow initialization to complete within the extended attempt budget", async () => {
        vi.useFakeTimers()
        try {
            const tracker = { setTaskFileTracker: vi.fn() } as never
            const slowTracker = new Promise<CheckpointTracker | undefined>((resolve) =>
                setTimeout(() => resolve(tracker), 45_000),
            )
            const create = vi.fn<CreateCheckpointTracker>(() => slowTracker)
            const harness = createManager(create)

            const initialization = harness.manager.retryCheckpointInitialization()
            await vi.advanceTimersByTimeAsync(45_000)

            await expect(initialization).resolves.toBe(true)
            expect(create).toHaveBeenCalledOnce()
            expect(harness.setCheckpointTracker).toHaveBeenCalledWith(tracker)
        } finally {
            vi.useRealTimers()
        }
    })

    it("reuses the timed-out attempt on retry instead of starting a second tracker", async () => {
        vi.useFakeTimers()
        try {
            const tracker = { setTaskFileTracker: vi.fn() } as never
            // Resolves after the 55s attempt timeout but well within the retry wait:
            // the first attempt times out, the retry must join this same promise.
            const slowTracker = new Promise<CheckpointTracker | undefined>((resolve) =>
                setTimeout(() => resolve(tracker), 60_000),
            )
            const create = vi.fn<CreateCheckpointTracker>(() => slowTracker)
            const harness = createManager(create)

            const initialization = harness.manager.retryCheckpointInitialization()
            await vi.advanceTimersByTimeAsync(60_100)

            await expect(initialization).resolves.toBe(true)
            // A second create would have raced the first for the shadow-repo mutex
            // and repeated the full baseline scan.
            expect(create).toHaveBeenCalledOnce()
            expect(harness.setCheckpointTracker).toHaveBeenCalledWith(tracker)
        } finally {
            vi.useRealTimers()
        }
    })

    it("creates a chat-only checkpoint when Git initialization is unavailable", async () => {
        const messages: UiMessage[] = []
        const create = vi.fn<CreateCheckpointTracker>().mockRejectedValue(new Error("Git must be installed to use checkpoints."))
        const harness = createManager(create, undefined, { messages })

        await harness.manager.saveCheckpoint()

        expect(create).toHaveBeenCalledOnce()
        expect(messages).toEqual([expect.objectContaining({ say: "checkpoint_created" })])
        expect(messages[0]).not.toHaveProperty("lastCheckpointHash")
        expect(harness.taskState.checkpointManagerErrorMessage).toContain("Git must be installed")
    })

    it("captures a chat-only canonical bundle when file checkpoints are unavailable", async () => {
        const messages: UiMessage[] = []
        const capture = vi.fn(async () => undefined)
        const create = vi.fn<CreateCheckpointTracker>().mockRejectedValue(new Error("Git unavailable"))
        const harness = createManager(create, undefined, {
            messages,
            canonicalCheckpoint: { capture, restore: vi.fn() },
        })

        await harness.manager.saveCheckpoint()

        expect(capture).toHaveBeenCalledExactlyOnceWith({ messageTs: 42 })
    })

    it("writes the workspace baseline into both the round row and canonical bundle", async () => {
        const messages: UiMessage[] = []
        const baselineHash = "shadow-baseline-hash"
        const tracker = {
            setTaskFileTracker: vi.fn(),
            commit: vi.fn().mockResolvedValue(baselineHash),
        } as unknown as CheckpointTracker
        const create = vi.fn<CreateCheckpointTracker>().mockResolvedValue(tracker)
        const capture = vi.fn(async () => undefined)
        const harness = createManager(create, undefined, {
            messages,
            tracker,
            canonicalCheckpoint: { capture, restore: vi.fn() },
        })

        await harness.manager.saveCheckpoint()

        expect(tracker.commit).toHaveBeenCalledOnce()
        expect(messages).toEqual([
            expect.objectContaining({
                say: "checkpoint_created",
                lastCheckpointHash: [baselineHash],
                checkpointWorkspaceRoots: ["C:/workspace"],
            }),
        ])
        expect(harness.updateClineMessage).not.toHaveBeenCalled()
        expect(capture).toHaveBeenCalledExactlyOnceWith({ messageTs: 42, workspaceRef: singleRootWorkspaceRef(baselineHash) })
    })

    it("keeps a durable completion hash when republishing its row fails", async () => {
        const completionMessage: UiMessage = { ts: 84, type: "say", say: "completion_result" }
        const messages = [completionMessage]
        const tracker = {
            setTaskFileTracker: vi.fn(),
            commit: vi.fn().mockResolvedValue("completion-hash"),
            getConsecutiveStagingFailures: vi.fn().mockReturnValue(0),
        } as unknown as CheckpointTracker
        const harness = createManager(vi.fn<CreateCheckpointTracker>().mockResolvedValue(tracker), undefined, {
            messages,
            tracker,
        })
        harness.publishMessage.mockRejectedValueOnce(new Error("webview closed"))

        await harness.manager.saveCheckpoint(true, completionMessage.ts)

        expect(messages[0]).toMatchObject({ lastCheckpointHash: ["completion-hash"] })
        expect(harness.postStateToWebview).toHaveBeenCalled()
    })

    it("durably binds a completion checkpoint before posting its updated UI state", async () => {
        const completionMessage: UiMessage = { ts: 84, type: "say", say: "completion_result" }
        const messages = [completionMessage]
        const completionHash = "completion-checkpoint-hash"
        const tracker = {
            setTaskFileTracker: vi.fn(),
            commit: vi.fn().mockResolvedValue(completionHash),
            getConsecutiveStagingFailures: vi.fn().mockReturnValue(0),
        } as unknown as CheckpointTracker
        const harness = createManager(vi.fn<CreateCheckpointTracker>().mockResolvedValue(tracker), undefined, {
            messages,
            tracker,
        })

        await harness.manager.saveCheckpoint(true, completionMessage.ts)

        expect(messages[0]).toEqual(
            expect.objectContaining({ lastCheckpointHash: [completionHash], checkpointWorkspaceRoots: ["C:/workspace"] }),
        )
        expect(harness.updateClineMessage).toHaveBeenCalledWith(0, {
            lastCheckpointHash: [completionHash],
            checkpointWorkspaceRoots: ["C:/workspace"],
        })
        expect(harness.flushMessageUpdate).toHaveBeenCalledWith(0)
        expect(harness.flushMessageUpdate.mock.invocationCallOrder[0]).toBeLessThan(
            harness.postStateToWebview.mock.invocationCallOrder[0],
        )
    })

    it("reopens the checkpoint hash from ui_messages.jsonl before publishing the committed state", async () => {
        const previousDocsDir = process.env.DLINE_DOCS_DIR
        const docsDir = await mkdtemp(path.join(os.tmpdir(), "dline-checkpoint-message-"))
        process.env.DLINE_DOCS_DIR = docsDir
        try {
            const taskId = "task-durable-checkpoint-message"
            const checkpointHash = "durable-checkpoint-hash"
            const nextCheckpointHash = "next-checkpoint-hash"
            const uiMessage = await UIMessage.open(taskId)
            const messageStateHandler = new MessageStateHandler({
                taskId,
                ulid: "ulid-durable-checkpoint-message",
                uiMessage,
                updateTaskHistory: async () => [],
            })
            const tracker = {
                setTaskFileTracker: vi.fn(),
                commit: vi.fn().mockResolvedValueOnce(checkpointHash).mockResolvedValueOnce(nextCheckpointHash),
                getDiffSet: vi
                    .fn()
                    .mockResolvedValue([
                        { relativePath: "changed.ts", absolutePath: "C:/workspace/changed.ts", before: "before", after: "after" },
                    ]),
            } as unknown as CheckpointTracker
            let nextMessageTs = 100
            const hashesObservedByPost: Array<string[] | undefined> = []
            const postStateToWebview = vi.fn(async () => {
                const reopenedAtPost = await UIMessage.open(taskId)
                hashesObservedByPost.push(reopenedAtPost.getAll().at(-1)?.lastCheckpointHash)
            })
            const manager = createTaskCheckpointManager(
                { taskId, controller: {} } as never,
                { enableCheckpoints: true, createCheckpointTracker: vi.fn().mockResolvedValue(tracker) },
                {
                    fileContextTracker: {},
                    diffViewProvider: {},
                    messageStateHandler,
                    taskState: new DefaultToolHandlerState(),
                    workspaceManager: { getPrimaryRoot: () => ({ path: "C:/workspace" }) },
                } as never,
                {
                    updateTaskHistory: vi.fn(),
                    cancelTask: vi.fn(),
                    restoreChatRuntime: vi.fn(),
                    say: vi.fn(),
                    beginRow: (fields: CheckpointRowFields) => {
                        const ts = ++nextMessageTs
                        const registered = messageStateHandler.beginDurableClineMessage({
                            ts,
                            type: "say",
                            say: "checkpoint_created",
                            ...fields,
                        })
                        return {
                            ts,
                            persistence: registered.persistence.then(async (row) => {
                                await postStateToWebview()
                                return row
                            }),
                        }
                    },
                    postStateToWebview,
                    publishMessage: vi.fn().mockResolvedValue(undefined),
                } as never,
                { checkpointTracker: tracker },
            )

            await manager.saveCheckpoint()
            await manager.saveCheckpoint()

            const reopened = await UIMessage.open(taskId)
            expect(tracker.getDiffSet).not.toHaveBeenCalled()
            expect(reopened.getAll()[0]?.lastCheckpointHash).toEqual([checkpointHash])
            expect(reopened.getAll().at(-1)?.lastCheckpointHash).toEqual([nextCheckpointHash])
            expect(hashesObservedByPost).toContainEqual([checkpointHash])
            expect(hashesObservedByPost).toContainEqual([nextCheckpointHash])
        } finally {
            if (previousDocsDir === undefined) delete process.env.DLINE_DOCS_DIR
            else process.env.DLINE_DOCS_DIR = previousDocsDir
            await closeInstanceStoragesUnder(docsDir)
            await rm(docsDir, { force: true, recursive: true })
        }
    })

    it("holds the round until the shadow commit finishes, then writes the row", async () => {
        const messages: UiMessage[] = []
        let releaseCommit: (hash: string) => void = () => undefined
        const tracker = {
            setTaskFileTracker: vi.fn(),
            commit: vi.fn(() => new Promise<string>((resolve) => (releaseCommit = resolve))),
        } as unknown as CheckpointTracker
        const create = vi.fn<CreateCheckpointTracker>().mockResolvedValue(tracker)
        const harness = createManager(create, undefined, { messages, tracker })

        let settled = false
        const source = { kind: "round_start" as const, turnId: "turn-baseline" }
        const round = harness.manager.ensureRoundCheckpoint("round_start", source).then(() => {
            settled = true
        })
        await vi.waitFor(() => expect(tracker.commit).toHaveBeenCalledOnce())
        // Synchronous with the conversation: the request waits, and no row exists yet.
        expect(settled).toBe(false)
        expect(messages).toEqual([])

        releaseCommit("baseline-hash")
        await round
        expect(messages).toEqual([
            expect.objectContaining({
                checkpointSource: source,
                lastCheckpointHash: ["baseline-hash"],
                checkpointWorkspaceRoots: ["C:/workspace"],
            }),
        ])
    })

    it("still writes the chat row and never rejects when the commit fails", async () => {
        const messages: UiMessage[] = []
        const tracker = {
            setTaskFileTracker: vi.fn(),
            commit: vi.fn().mockRejectedValue(new Error("shadow index is locked")),
        } as unknown as CheckpointTracker
        const create = vi.fn<CreateCheckpointTracker>().mockResolvedValue(tracker)
        const harness = createManager(create, undefined, { messages, tracker })

        await expect(harness.manager.ensureRoundCheckpoint("round_start")).resolves.toBeUndefined()

        expect(messages).toEqual([expect.objectContaining({ say: "checkpoint_created" })])
        expect(messages[0]).not.toHaveProperty("lastCheckpointHash")
    })

    it("finishes the checkpoint in progress on dispose and starts none afterwards", async () => {
        const messages: UiMessage[] = []
        let releaseCommit: (hash: string) => void = () => undefined
        const tracker = {
            setTaskFileTracker: vi.fn(),
            commit: vi.fn(() => new Promise<string>((resolve) => (releaseCommit = resolve))),
        } as unknown as CheckpointTracker
        const capture = vi.fn(async () => undefined)
        const create = vi.fn<CreateCheckpointTracker>().mockResolvedValue(tracker)
        const harness = createManager(create, undefined, {
            messages,
            tracker,
            canonicalCheckpoint: { capture, restore: vi.fn() },
        })

        const round = harness.manager.ensureRoundCheckpoint("round_start")
        await vi.waitFor(() => expect(tracker.commit).toHaveBeenCalledOnce())
        let disposed = false
        const disposal = harness.manager.dispose().then(() => {
            disposed = true
        })
        await Promise.resolve()
        expect(disposed).toBe(false)

        releaseCommit("late-baseline-hash")
        await round
        await disposal
        expect(messages).toEqual([
            expect.objectContaining({
                say: "checkpoint_created",
                lastCheckpointHash: ["late-baseline-hash"],
                checkpointWorkspaceRoots: ["C:/workspace"],
            }),
        ])
        expect(capture).toHaveBeenCalledOnce()

        await harness.manager.ensureRoundCheckpoint("round_start")
        expect(messages).toHaveLength(1)
        expect(tracker.commit).toHaveBeenCalledOnce()
    })

    it("adds no checkpoint when checkpoints are disabled", async () => {
        const messages: UiMessage[] = []
        const create = vi.fn<CreateCheckpointTracker>()
        const beginRow = vi.fn()
        const disabled = createTaskCheckpointManager(
            { taskId: "task-1", controller: {} } as never,
            { enableCheckpoints: false, createCheckpointTracker: create },
            { messageStateHandler: { clineMessages: messages } } as never,
            { say: vi.fn(), beginRow } as never,
            {},
        )

        await disabled.ensureRoundCheckpoint("round_start")

        expect(beginRow).not.toHaveBeenCalled()
        expect(messages).toEqual([])
        expect(create).not.toHaveBeenCalled()
    })

    it("does not retry a permanent missing Git capability error", async () => {
        const create = vi.fn<CreateCheckpointTracker>().mockRejectedValue(new Error("Git must be installed to use checkpoints."))
        const harness = createManager(create)

        const result = await harness.manager.retryCheckpointInitialization()

        expect(result).toBe(false)
        expect(create).toHaveBeenCalledOnce()
        expect(harness.taskState.checkpointManagerErrorMessage).toContain("Git must be installed")
    })
})
