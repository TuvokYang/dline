import { EmptyRequest } from "@shared/proto/dline/common"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { clearTask } from "../clearTask"

/**
 * Closing a Task only ends the session. A Task that already reached a
 * completion verdict must keep it: the history entry is the user's record that
 * the work finished, and reopening the closed Task must not present it as
 * unfinished.
 */
describe("clearTask handler", () => {
    it("preserves an established completion verdict when the user closes the task", async () => {
        const clearTaskSpy = vi.fn(async () => undefined)
        const controller = {
            clearTask: clearTaskSpy,
            postStateToWebview: vi.fn(async () => undefined),
        } as unknown as Controller

        await clearTask(controller, EmptyRequest.create())

        expect(clearTaskSpy).toHaveBeenCalledWith(
            expect.objectContaining({ preserveCompletedState: true, closeReason: "user_clear" }),
        )
    })

    it("still clears the panel state so the closed task leaves no visible session", async () => {
        const clearTaskSpy = vi.fn(async () => undefined)
        const postStateToWebview = vi.fn(async () => undefined)
        const controller = {
            clearTask: clearTaskSpy,
            postStateToWebview,
        } as unknown as Controller

        await clearTask(controller, EmptyRequest.create())

        expect(clearTaskSpy).toHaveBeenCalledWith(expect.objectContaining({ clearPanelState: true }))
        // clearTask publishes the detached state itself. Publishing again here
        // would only rebuild and rebroadcast the same state the user already sees.
        expect(postStateToWebview).not.toHaveBeenCalled()
    })

    /**
     * Returning to the recent-tasks view only requires the Task to be detached.
     * Keeping the user's close blocked on store flushes, lock release and
     * registry cleanup delays a view change that those steps cannot affect.
     */
    it("defers durable teardown so closing returns to the recent view immediately", async () => {
        const clearTaskSpy = vi.fn(async () => undefined)
        const controller = {
            clearTask: clearTaskSpy,
            postStateToWebview: vi.fn(async () => undefined),
        } as unknown as Controller

        await clearTask(controller, EmptyRequest.create())

        expect(clearTaskSpy).toHaveBeenCalledWith(expect.objectContaining({ deferTeardown: true }))
    })
})
