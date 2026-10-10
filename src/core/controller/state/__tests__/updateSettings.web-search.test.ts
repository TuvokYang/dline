import { UpdateSettingsRequest } from "@shared/proto/dline/state"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { updateSettings } from "../updateSettings"

function createController() {
    const setGlobalState = vi.fn()
    const setSecret = vi.fn()
    const flushPendingState = vi.fn().mockResolvedValue(undefined)
    const controller = {
        configureGlobalComponents: vi.fn().mockResolvedValue({ components: [], durationMs: 0 }),
        stateManager: { flushPendingState, setGlobalState, setSecret },
        postStateToWebview: vi.fn().mockResolvedValue(undefined),
    } as unknown as Controller
    return { controller, setGlobalState, setSecret }
}

describe("updateSettings local Web Search", () => {
    it("persists the selected engine and SearXNG endpoint as non-secret settings", async () => {
        const { controller, setGlobalState } = createController()
        const request = UpdateSettingsRequest.create({
            localWebSearchEngine: "searxng",
            searxngSearchUrl: "https://search.example.test",
        })

        await updateSettings(controller, request)

        expect(setGlobalState).toHaveBeenCalledWith("localWebSearchEngine", "searxng")
        expect(setGlobalState).toHaveBeenCalledWith("searxngSearchUrl", "https://search.example.test")
    })

    it("stores the SearXNG token only in Secret Storage", async () => {
        const { controller, setGlobalState, setSecret } = createController()
        const request = UpdateSettingsRequest.create({ searxngSearchToken: "private-token" })

        await updateSettings(controller, request)

        expect(setSecret).toHaveBeenCalledWith("searxngSearchToken", "private-token")
        expect(setGlobalState).not.toHaveBeenCalledWith("searxngSearchToken", expect.anything())
    })

    it("deletes the SearXNG token when the submitted value is empty", async () => {
        const { controller, setSecret } = createController()
        const request = UpdateSettingsRequest.create({ searxngSearchToken: "   " })

        await updateSettings(controller, request)

        expect(setSecret).toHaveBeenCalledWith("searxngSearchToken", undefined)
    })

    it("rejects unsupported engine identifiers", async () => {
        const { controller, setGlobalState, setSecret } = createController()
        const request = UpdateSettingsRequest.create({
            localWebSearchEngine: "cline-cloud",
            searxngSearchToken: "must-not-be-written",
        })

        await expect(updateSettings(controller, request)).rejects.toThrow("Unsupported local web search engine")
        expect(setGlobalState).not.toHaveBeenCalledWith("localWebSearchEngine", expect.anything())
        expect(setSecret).not.toHaveBeenCalled()
    })
})
