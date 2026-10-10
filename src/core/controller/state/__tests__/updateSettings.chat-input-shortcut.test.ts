import { UpdateSettingsRequest } from "@shared/proto/dline/state"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { updateSettings } from "../updateSettings"

function createController() {
    const setGlobalState = vi.fn()
    const flushPendingState = vi.fn().mockResolvedValue(undefined)
    const postStateToWebview = vi.fn().mockResolvedValue(undefined)
    const configureGlobalComponents = vi.fn().mockResolvedValue({ components: [], durationMs: 0 })
    const controller = {
        configureGlobalComponents,
        stateManager: { flushPendingState, setGlobalState },
        postStateToWebview,
    } as unknown as Controller

    return { configureGlobalComponents, controller, flushPendingState, postStateToWebview, setGlobalState }
}

describe("updateSettings chat input shortcut", () => {
    it.each(["enter", "ctrlEnter", "shiftEnter"] as const)("durably persists %s before publishing success", async (shortcut) => {
        const { configureGlobalComponents, controller, flushPendingState, postStateToWebview, setGlobalState } =
            createController()

        await updateSettings(controller, UpdateSettingsRequest.create({ chatInputSendShortcut: shortcut }))

        expect(setGlobalState).toHaveBeenCalledWith("chatInputSendShortcut", shortcut)
        expect(flushPendingState).toHaveBeenCalledOnce()
        expect(flushPendingState.mock.invocationCallOrder[0]).toBeLessThan(configureGlobalComponents.mock.invocationCallOrder[0])
        expect(configureGlobalComponents.mock.invocationCallOrder[0]).toBeLessThan(postStateToWebview.mock.invocationCallOrder[0])
    })

    it("propagates persistence failure without reconfiguring or publishing state", async () => {
        const { configureGlobalComponents, controller, flushPendingState, postStateToWebview } = createController()
        flushPendingState.mockRejectedValueOnce(new Error("durable Settings write failed"))

        await expect(
            updateSettings(controller, UpdateSettingsRequest.create({ chatInputSendShortcut: "ctrlEnter" })),
        ).rejects.toThrow("durable Settings write failed")

        expect(configureGlobalComponents).not.toHaveBeenCalled()
        expect(postStateToWebview).not.toHaveBeenCalled()
    })

    it("rejects unsupported values", async () => {
        const { configureGlobalComponents, controller, setGlobalState } = createController()

        let error: unknown
        try {
            await updateSettings(controller, UpdateSettingsRequest.create({ chatInputSendShortcut: "unsupported" }))
        } catch (caught) {
            error = caught
        }

        expect(error).toBeInstanceOf(Error)
        expect(setGlobalState).not.toHaveBeenCalled()
        expect(configureGlobalComponents).not.toHaveBeenCalled()
    })
})
