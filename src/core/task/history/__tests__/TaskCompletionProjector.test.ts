import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type TaskState } from "../../kernel"
import { TaskCompletionProjector } from "../TaskCompletionProjector"

function runtimeState(phase: TaskState["flow"]["phase"], revision: number, completionId?: string): TaskState {
    return {
        ...createInitialTaskState("task-1"),
        revision,
        flow: { phase, ...(completionId ? { completionId } : {}) },
    }
}

describe("TaskCompletionProjector", () => {
    it("persists only authoritative completion state flips", async () => {
        const persist = vi.fn(async () => true)
        const projector = new TaskCompletionProjector({ taskId: "task-1", persist })

        await expect(projector.sync(runtimeState("running", 1))).resolves.toBe(false)
        await expect(projector.sync(runtimeState("completed", 2, "completion-1"))).resolves.toBe(true)
        await expect(projector.sync(runtimeState("completed", 3, "completion-1"))).resolves.toBe(false)
        await expect(projector.sync(runtimeState("running", 4))).resolves.toBe(true)

        expect(persist.mock.calls).toEqual([
            [{ taskId: "task-1", isCompleted: true, revision: 2 }],
            [{ taskId: "task-1", isCompleted: false, revision: 4 }],
        ])
    })

    // The kernel presents a completion as the completion dialog offered to the
    // user while the flow stays running; it never writes a completion identity.
    it("treats an offered completion dialog as completed and a closed session as no verdict", async () => {
        const persist = vi.fn(async () => true)
        const projector = new TaskCompletionProjector({ taskId: "task-1", persist })
        const withDialog = (state: TaskState, kind: string, status: string): TaskState =>
            ({ ...state, dialog: { ...state.dialog, primary: { interactionId: "i-1", kind, status } } }) as unknown as TaskState

        await expect(projector.sync(withDialog(runtimeState("waiting", 2), "completion", "awaiting"))).resolves.toBe(true)
        await expect(projector.sync(withDialog(runtimeState("waiting", 3), "completion", "resolving"))).resolves.toBe(false)
        await expect(projector.sync(runtimeState("completed", 4))).resolves.toBe(false)
        await expect(projector.sync(runtimeState("terminated", 5))).resolves.toBe(false)
        await expect(projector.sync(withDialog(runtimeState("running", 6), "question", "awaiting"))).resolves.toBe(true)

        expect(persist.mock.calls).toEqual([
            [{ taskId: "task-1", isCompleted: true, revision: 2 }],
            [{ taskId: "task-1", isCompleted: false, revision: 6 }],
        ])
    })

    it("advances the local revision watermark without persisting an unchanged value", async () => {
        const persist = vi.fn(async () => true)
        const projector = new TaskCompletionProjector({ taskId: "task-1", persist })

        await expect(projector.sync(runtimeState("completed", 2, "completion-1"))).resolves.toBe(true)
        await expect(projector.sync(runtimeState("completed", 5, "completion-1"))).resolves.toBe(false)
        await expect(projector.sync(runtimeState("running", 4))).resolves.toBe(false)
        await expect(projector.sync(runtimeState("running", 6))).resolves.toBe(true)

        expect(persist.mock.calls).toEqual([
            [{ taskId: "task-1", isCompleted: true, revision: 2 }],
            [{ taskId: "task-1", isCompleted: false, revision: 6 }],
        ])
    })

    it("requires a completion identity before projecting completed", async () => {
        const persist = vi.fn(async () => true)
        const projector = new TaskCompletionProjector({ taskId: "task-1", persist })

        await expect(projector.sync(runtimeState("completed", 2))).resolves.toBe(false)
        expect(persist).not.toHaveBeenCalled()
    })

    it("preserves a valid initial projection until the task leaves completed", async () => {
        const persist = vi.fn(async () => true)
        const projector = new TaskCompletionProjector({
            taskId: "task-1",
            initial: { isCompleted: true, revision: 5 },
            persist,
        })

        await expect(projector.sync(runtimeState("completed", 6, "completion-1"))).resolves.toBe(false)
        await expect(projector.sync(runtimeState("paused", 7))).resolves.toBe(true)
        expect(persist).toHaveBeenCalledExactlyOnceWith({ taskId: "task-1", isCompleted: false, revision: 7 })
    })

    it("retries a failed persistence instead of accepting an in-memory-only projection", async () => {
        const persist = vi.fn().mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValueOnce(true)
        const projector = new TaskCompletionProjector({ taskId: "task-1", persist })
        const completed = runtimeState("completed", 2, "completion-1")

        await expect(projector.sync(completed)).rejects.toThrow("disk unavailable")
        await expect(projector.sync(completed)).resolves.toBe(true)
        expect(persist).toHaveBeenCalledTimes(2)
    })

    it("keeps a completed projection while a reopened task is not yet hydrated", async () => {
        const persist = vi.fn(async () => true)
        const projector = new TaskCompletionProjector({
            taskId: "task-1",
            initial: { isCompleted: true, revision: 12 },
            persist,
        })

        await expect(projector.sync(runtimeState("idle", 0))).resolves.toBe(false)
        await expect(projector.sync(runtimeState("initializing", 1))).resolves.toBe(false)
        await expect(projector.sync(runtimeState("completed", 2, "completion-1"))).resolves.toBe(false)

        expect(persist).not.toHaveBeenCalled()
    })

    it("keeps a completed projection while the session terminates", async () => {
        const persist = vi.fn(async () => true)
        const projector = new TaskCompletionProjector({
            taskId: "task-1",
            initial: { isCompleted: true, revision: 12 },
            persist,
        })

        await expect(projector.sync(runtimeState("terminated", 13))).resolves.toBe(false)
        expect(persist).not.toHaveBeenCalled()
    })

    it("lifts a restarted runtime revision above the durable watermark", async () => {
        const persist = vi.fn(async () => true)
        const projector = new TaskCompletionProjector({
            taskId: "task-1",
            initial: { isCompleted: true, revision: 12 },
            persist,
        })

        await expect(projector.sync(runtimeState("running", 2))).resolves.toBe(true)
        expect(persist).toHaveBeenCalledExactlyOnceWith({ taskId: "task-1", isCompleted: false, revision: 13 })
    })

    it("does not advance the local projection when storage rejects a stale update", async () => {
        const persist = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
        const projector = new TaskCompletionProjector({ taskId: "task-1", persist })
        const completed = runtimeState("completed", 2, "completion-1")

        await expect(projector.sync(completed)).resolves.toBe(false)
        await expect(projector.sync(completed)).resolves.toBe(true)
        expect(persist).toHaveBeenCalledTimes(2)
    })
})
