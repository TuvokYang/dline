import { projectAggressiveRendering } from "@shared/AggressiveRendering"
import { UpdateSettingsRequest } from "@shared/proto/dline/state"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { updateSettings } from "../updateSettings"

function createController() {
    const setGlobalState = vi.fn()
    const controller = {
        configureGlobalComponents: vi.fn().mockResolvedValue({ components: [], durationMs: 0 }),
        stateManager: { flushPendingState: vi.fn().mockResolvedValue(undefined), setGlobalState },
        postStateToWebview: vi.fn().mockResolvedValue(undefined),
    } as unknown as Controller

    return { controller, setGlobalState }
}

describe("updateSettings aggressive rendering", () => {
    it.each(["standard", "activity", "turn"] as const)("persists the %s level", async (level) => {
        const { controller, setGlobalState } = createController()

        await updateSettings(controller, UpdateSettingsRequest.create({ aggressiveRendering: level }))

        expect(setGlobalState).toHaveBeenCalledWith("aggressiveRendering", level)
    })

    it("rejects an unknown level without writing it", async () => {
        const { controller, setGlobalState } = createController()

        await expect(updateSettings(controller, UpdateSettingsRequest.create({ aggressiveRendering: "round" }))).rejects.toThrow(
            "Invalid aggressive rendering level: round",
        )
        expect(setGlobalState).not.toHaveBeenCalledWith("aggressiveRendering", expect.anything())
    })

    it("leaves the level untouched when the request does not carry it", async () => {
        const { controller, setGlobalState } = createController()

        await updateSettings(controller, UpdateSettingsRequest.create({ chatInputSendShortcut: "enter" }))

        expect(setGlobalState).not.toHaveBeenCalledWith("aggressiveRendering", expect.anything())
    })
})

describe("aggressive rendering settings round trip", () => {
    /** Settings written by the real handler land in a map that the projection reads back. */
    function createStoredController() {
        const settings = new Map<string, unknown>()
        const controller = {
            configureGlobalComponents: vi.fn().mockResolvedValue({ components: [], durationMs: 0 }),
            stateManager: {
                flushPendingState: vi.fn().mockResolvedValue(undefined),
                setGlobalState: (key: string, value: unknown) => settings.set(key, value),
            },
            postStateToWebview: vi.fn().mockResolvedValue(undefined),
        } as unknown as Controller
        return { controller, stored: () => settings.get("aggressiveRendering") }
    }

    it.each([
        ["standard", { user: "standard", featureFlag: true }],
        ["activity", { user: "activity", featureFlag: true }],
        ["turn", { user: "turn", featureFlag: true }],
    ] as const)("projects a saved %s choice back to the webview", async (level, expected) => {
        const { controller, stored } = createStoredController()

        await updateSettings(controller, UpdateSettingsRequest.create({ aggressiveRendering: level }))

        expect(projectAggressiveRendering(stored(), true)).toEqual(expected)
    })

    it("keeps the saved choice while the rollout is off and returns it when the rollout is back", async () => {
        const { controller, stored } = createStoredController()
        await updateSettings(controller, UpdateSettingsRequest.create({ aggressiveRendering: "turn" }))

        expect(projectAggressiveRendering(stored(), false)).toEqual({ user: "turn", featureFlag: false })
        expect(projectAggressiveRendering(stored(), true)).toEqual({ user: "turn", featureFlag: true })
    })

    it.each([
        ["a never-saved setting", undefined],
        ["a value from an older build", "round"],
        ["a value of the wrong type", 2],
    ])("projects %s as standard", (_case, storedValue) => {
        expect(projectAggressiveRendering(storedValue, true)).toEqual({ user: "standard", featureFlag: true })
    })
})
