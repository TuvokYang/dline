import type { MessageStateHandler } from "@core/task/message-state"
import { describe, expect, it, vi } from "vitest"
import { ControllerTaskCallbacksOwner } from "../ControllerTaskCallbacksOwner"

/**
 * In-task cancellation comes from hooks that run inside a halt participant. The
 * halt waits for that participant's work, so the callback must request the cancel
 * without waiting for the halt to settle.
 */
function owner(cancelTask: () => Promise<void>): ControllerTaskCallbacksOwner {
    return new ControllerTaskCallbacksOwner({
        controller: { cancelTask } as never,
        taskId: "task-1",
        taskInstanceId: "open-1",
        stateManager: {
            getGlobalSettingsKey: () => ({ enabled: false, remindClineInterval: 6 }),
            getGlobalStateKey: () => undefined,
        } as never,
        messages: { clineMessages: [] } as unknown as MessageStateHandler,
        interactions: {} as never,
        nextPresentationId: () => 1,
        api: {} as never,
        toolState: {} as never,
        createBrowser: () => ({}) as never,
    })
}

describe("ControllerTaskCallbacksOwner cancelTask", () => {
    it("requests the cancel synchronously and settles before the halt completes", async () => {
        let settleHalt!: () => void
        const halt = new Promise<void>((resolve) => (settleHalt = resolve))
        const cancelTask = vi.fn(() => halt)
        let callbackSettled = false

        const requested = owner(cancelTask)
            .callbacks.cancelTask()
            .then(() => {
                callbackSettled = true
            })

        expect(cancelTask).toHaveBeenCalledTimes(1)
        await requested
        expect(callbackSettled).toBe(true)
        settleHalt()
        await halt
    })

    it("does not surface a failed cancel to the in-task caller", async () => {
        const cancelTask = vi.fn(() => Promise.reject(new Error("runtime closed")))

        await expect(owner(cancelTask).callbacks.cancelTask()).resolves.toBeUndefined()
        expect(cancelTask).toHaveBeenCalledTimes(1)
    })
})
