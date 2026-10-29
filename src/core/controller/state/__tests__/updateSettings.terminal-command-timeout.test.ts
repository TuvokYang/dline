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

    return { configureGlobalComponents, controller, postStateToWebview, setGlobalState }
}

describe("updateSettings terminal command timeout", () => {
    it.each([60, 1800, 3600])("persists a valid %s-second deadline", async (timeoutSeconds) => {
        const { configureGlobalComponents, controller, postStateToWebview, setGlobalState } = createController()

        await updateSettings(controller, UpdateSettingsRequest.create({ terminalCommandTimeoutSeconds: timeoutSeconds }))

        expect(setGlobalState).toHaveBeenCalledWith("terminalCommandTimeoutSeconds", timeoutSeconds)
        expect(configureGlobalComponents).toHaveBeenCalledOnce()
        expect(postStateToWebview).toHaveBeenCalledOnce()
    })

    it.each([0, 59])("rejects %s seconds because Settings has a one-minute minimum", async (timeoutSeconds) => {
        const { controller, setGlobalState } = createController()

        await expect(
            updateSettings(controller, UpdateSettingsRequest.create({ terminalCommandTimeoutSeconds: timeoutSeconds })),
        ).rejects.toThrow(/at least 60 seconds/i)
        expect(setGlobalState).not.toHaveBeenCalled()
    })

    it.each([1, 10, 30])("persists a valid %s-second foreground handoff", async (handoffSeconds) => {
        const { configureGlobalComponents, controller, postStateToWebview, setGlobalState } = createController()

        await updateSettings(controller, UpdateSettingsRequest.create({ terminalCommandHandoffSeconds: handoffSeconds }))

        expect(setGlobalState).toHaveBeenCalledWith("terminalCommandHandoffSeconds", handoffSeconds)
        expect(configureGlobalComponents).toHaveBeenCalledOnce()
        expect(postStateToWebview).toHaveBeenCalledOnce()
    })

    it.each([0, -1, 1.5])("rejects %s seconds because the handoff minimum is one second", async (handoffSeconds) => {
        const { controller, setGlobalState } = createController()

        await expect(
            updateSettings(controller, UpdateSettingsRequest.create({ terminalCommandHandoffSeconds: handoffSeconds })),
        ).rejects.toThrow(/at least 1 seconds/i)
        expect(setGlobalState).not.toHaveBeenCalled()
    })
})
