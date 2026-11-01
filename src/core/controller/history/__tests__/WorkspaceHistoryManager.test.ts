import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it, vi } from "vitest"
import {
    clearWorkspaceHistoryManagersForTests,
    getWorkspaceHistoryManager,
    WorkspaceHistoryManager,
} from "../WorkspaceHistoryManager"

function item(overrides: Partial<HistoryItem> = {}): HistoryItem {
    return {
        id: "task-1",
        ts: 1,
        task: "History task",
        tokensIn: 0,
        tokensOut: 0,
        totalCost: 0,
        ...overrides,
    }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

describe("WorkspaceHistoryManager", () => {
    it("does not serialize one task's write behind another task's", async () => {
        let cache: HistoryItem[] = []
        const slow = deferred()
        const writer = {
            upsertTaskHistory: vi.fn(async (accepted: HistoryItem) => {
                // Only the first task is held; the second must not wait for it.
                if (accepted.id === "task-slow") await slow.promise
                return accepted
            }),
            setCompletionState: vi.fn(async () => undefined),
            flush: vi.fn(async () => undefined),
        }
        const manager = new WorkspaceHistoryManager("workspace", {
            readCache: () => cache,
            writeCache: (history) => {
                cache = history
            },
            writer,
            onError: vi.fn(),
        })

        await manager.publishMetadata(item({ id: "task-slow" }), manager.beginTask("task-slow"))
        await manager.publishMetadata(item({ id: "task-fast" }), manager.beginTask("task-fast"))

        // With one workspace-wide chain the fast write could not land until the
        // slow one settled, so this assertion is what distinguishes the domains.
        await vi.waitFor(() =>
            expect(writer.upsertTaskHistory).toHaveBeenCalledWith(expect.objectContaining({ id: "task-fast" })),
        )
        expect(writer.upsertTaskHistory).toHaveBeenCalledTimes(2)

        slow.resolve()
    })

    it("drains every task chain on flush", async () => {
        let cache: HistoryItem[] = []
        const pending = [deferred(), deferred()]
        let releaseIndex = 0
        const writer = {
            upsertTaskHistory: vi.fn(async (accepted: HistoryItem) => {
                const gate = pending[releaseIndex++]
                if (gate) await gate.promise
                return accepted
            }),
            setCompletionState: vi.fn(async () => undefined),
            flush: vi.fn(async () => undefined),
        }
        const manager = new WorkspaceHistoryManager("workspace", {
            readCache: () => cache,
            writeCache: (history) => {
                cache = history
            },
            writer,
            onError: vi.fn(),
        })

        await manager.publishMetadata(item({ id: "task-a" }), manager.beginTask("task-a"))
        await manager.publishMetadata(item({ id: "task-b" }), manager.beginTask("task-b"))

        let drained = false
        const flushing = manager.flush().then(() => {
            drained = true
        })
        await Promise.resolve()
        // Waiting for a single chain would let this resolve with task-b unwritten.
        expect(drained).toBe(false)

        // Releasing one gate at a time is what distinguishes "drains every chain"
        // from "awaits whichever chain it happened to read first": with both gates
        // released together, awaiting a single chain also lets the whole flush
        // settle, because the other write has nothing left to wait for.
        pending[0].resolve()
        await vi.waitFor(() => expect(writer.upsertTaskHistory).toHaveBeenCalledTimes(2))
        await Promise.resolve()
        expect(drained).toBe(false)

        pending[1].resolve()
        await flushing
        expect(drained).toBe(true)
        expect(writer.flush).toHaveBeenCalledOnce()
    })

    it("accepts metadata before the physical writer settles", async () => {
        let cache: HistoryItem[] = []
        const write = deferred()
        const writer = {
            upsertTaskHistory: vi.fn(async (accepted: HistoryItem) => {
                await write.promise
                return accepted
            }),
            setCompletionState: vi.fn(async () => undefined),
            flush: vi.fn(async () => undefined),
        }
        const manager = new WorkspaceHistoryManager("workspace", {
            readCache: () => cache,
            writeCache: (history) => {
                cache = history
            },
            writer,
            onError: vi.fn(),
        })
        const session = manager.beginTask("task-1")

        await expect(manager.publishMetadata(item({ tokensIn: 12 }), session)).resolves.toEqual([
            expect.objectContaining({ id: "task-1", tokensIn: 12 }),
        ])
        expect(cache).toEqual([expect.objectContaining({ id: "task-1", tokensIn: 12 })])
        await vi.waitFor(() => expect(writer.upsertTaskHistory).toHaveBeenCalledOnce())

        let durable = false
        const flushing = manager.flush().then(() => {
            durable = true
        })
        await Promise.resolve()
        expect(durable).toBe(false)
        write.resolve()
        await flushing
        expect(writer.flush).toHaveBeenCalledOnce()
    })

    it("drops queued events after the Task generation closes", async () => {
        let cache: HistoryItem[] = []
        const writer = {
            upsertTaskHistory: vi.fn(async (accepted: HistoryItem) => accepted),
            setCompletionState: vi.fn(async () => undefined),
            flush: vi.fn(async () => undefined),
        }
        const manager = new WorkspaceHistoryManager("workspace", {
            readCache: () => cache,
            writeCache: (history) => {
                cache = history
            },
            writer,
            onError: vi.fn(),
        })
        const session = manager.beginTask("task-1")

        const accepted = manager.publishMetadata(item(), session)
        manager.closeTask(session)
        await accepted
        await manager.flush()

        expect(writer.upsertTaskHistory).not.toHaveBeenCalled()
        expect(cache).toEqual([expect.objectContaining({ id: "task-1" })])
    })

    it("continues processing after a writer failure", async () => {
        let cache: HistoryItem[] = []
        const onError = vi.fn()
        const writer = {
            upsertTaskHistory: vi
                .fn<(accepted: HistoryItem) => Promise<HistoryItem>>()
                .mockRejectedValueOnce(new Error("disk unavailable"))
                .mockImplementation(async (accepted) => accepted),
            setCompletionState: vi.fn(async () => undefined),
            flush: vi.fn(async () => undefined),
        }
        const manager = new WorkspaceHistoryManager("workspace", {
            readCache: () => cache,
            writeCache: (history) => {
                cache = history
            },
            writer,
            onError,
        })

        await manager.publishMetadata(item(), manager.beginTask("task-1"))
        await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
        await manager.publishMetadata(item({ id: "task-2" }), manager.beginTask("task-2"))
        await manager.flush()

        expect(writer.upsertTaskHistory).toHaveBeenCalledTimes(2)
        expect(cache.map((candidate) => candidate.id)).toEqual(["task-1", "task-2"])
    })

    it("shares one process-static manager for the same workspace", () => {
        clearWorkspaceHistoryManagersForTests()
        const ports = {
            readCache: () => [] as HistoryItem[],
            writeCache: vi.fn(),
            writer: {
                upsertTaskHistory: vi.fn(async (accepted: HistoryItem) => accepted),
                setCompletionState: vi.fn(async () => undefined),
                flush: vi.fn(async () => undefined),
            },
            onError: vi.fn(),
        }

        const first = getWorkspaceHistoryManager("workspace", ports)
        const second = getWorkspaceHistoryManager("workspace", ports)

        expect(second).toBe(first)
        clearWorkspaceHistoryManagersForTests()
    })

    it("accepts completion in memory without waiting for the durable patch", async () => {
        let cache: HistoryItem[] = [item({ isCompleted: true, completionStateRevision: 2 })]
        const completion = deferred()
        const writer = {
            upsertTaskHistory: vi.fn(async (accepted: HistoryItem) => accepted),
            setCompletionState: vi.fn(async () => {
                await completion.promise
                return item({ isCompleted: false, completionStateRevision: 3 })
            }),
            flush: vi.fn(async () => undefined),
        }
        const manager = new WorkspaceHistoryManager("workspace", {
            readCache: () => cache,
            writeCache: (history) => {
                cache = history
            },
            writer,
            onError: vi.fn(),
        })
        const session = manager.beginTask("task-1")

        await expect(manager.publishCompletion({ taskId: "task-1", isCompleted: false, revision: 3 }, session)).resolves.toBe(
            true,
        )
        expect(cache[0]).toMatchObject({ isCompleted: false, completionStateRevision: 3 })
        completion.resolve()
        await manager.flush()
    })
})
