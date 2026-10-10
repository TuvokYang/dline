import { InteractionCancellationError } from "@core/task/interaction/InteractionCancellationError"
import { describe, expect, it, vi } from "vitest"
import { startTaskLifecycle } from "../task-start-lifecycle"

describe("startTaskLifecycle", () => {
    it("returns after background admission without waiting for task completion", async () => {
        const events: string[] = []
        let finishStart: (() => void) | undefined
        const pendingStart = new Promise<void>((resolve) => {
            finishStart = resolve
        })
        const beforeStart = vi.fn(async () => {
            events.push("before-start")
        })
        const onBackgroundError = vi.fn(async () => undefined)

        await startTaskLifecycle({
            taskId: "child-1",
            startInBackground: true,
            beforeStart,
            start: () => {
                events.push("start")
                return pendingStart
            },
            onBackgroundError,
        })

        expect(beforeStart).toHaveBeenCalledWith("child-1")
        expect(events).toEqual(["before-start", "start"])
        expect(onBackgroundError).not.toHaveBeenCalled()
        finishStart?.()
    })

    it("preserves foreground wait semantics", async () => {
        let finishStart: (() => void) | undefined
        const pendingStart = new Promise<void>((resolve) => {
            finishStart = resolve
        })
        let settled = false
        const execution = startTaskLifecycle({
            taskId: "task-1",
            startInBackground: false,
            start: () => pendingStart,
            onBackgroundError: async () => undefined,
        }).then(() => {
            settled = true
        })

        await Promise.resolve()
        expect(settled).toBe(false)
        finishStart?.()
        await execution
        expect(settled).toBe(true)
    })

    it("reports rejected background starts", async () => {
        const onBackgroundError = vi.fn<(error: unknown) => Promise<void>>(async () => undefined)

        await startTaskLifecycle({
            taskId: "child-1",
            startInBackground: true,
            start: async () => {
                throw new Error("background failed")
            },
            onBackgroundError,
        })
        await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledOnce())
        expect(onBackgroundError.mock.calls[0]?.[0]).toMatchObject({ message: "background failed" })
    })

    it("ignores expected interaction cancellation from background starts", async () => {
        let rejectStart: ((error: unknown) => void) | undefined
        const pendingStart = new Promise<void>((_resolve, reject) => {
            rejectStart = reject
        })
        const onBackgroundError = vi.fn<(error: unknown) => Promise<void>>(async () => undefined)

        await startTaskLifecycle({
            taskId: "child-1",
            startInBackground: true,
            start: () => pendingStart,
            onBackgroundError,
        })

        const cancellation = new InteractionCancellationError("task_terminated")
        rejectStart?.(cancellation)
        await expect(pendingStart).rejects.toBe(cancellation)
        await Promise.resolve()
        expect(onBackgroundError).not.toHaveBeenCalled()
    })
})
