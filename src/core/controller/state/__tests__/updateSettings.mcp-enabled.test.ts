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

    return { controller, setGlobalState }
}

describe("updateSettings feature toggles", () => {
    it("persists the MCP feature gate", async () => {
        const { controller, setGlobalState } = createController()

        await updateSettings(controller, UpdateSettingsRequest.create({ mcpEnabled: false }))

        expect(setGlobalState).toHaveBeenCalledWith("mcpEnabled", false)
    })

    it("persists the external file checkpoints user opt-in without enabling runtime behavior", async () => {
        const { controller, setGlobalState } = createController()

        await updateSettings(controller, UpdateSettingsRequest.create({ externalFileCheckpointsEnabled: true }))

        expect(setGlobalState).toHaveBeenCalledWith("externalFileCheckpointsEnabled", true)
    })
})
