import { DEFAULT_FOCUS_CHAIN_SETTINGS } from "@shared/FocusChainSettings"
import { describe, expect, it, vi } from "vitest"
import { DefaultToolHandlerState } from "../../tools/state/ToolHandlerState"
import { FocusChainManager } from ".."

function manager(interval: number, enabled = true) {
    const taskState = new DefaultToolHandlerState()
    const settings = { enabled, remindClineInterval: interval }
    const focusChain = new FocusChainManager({
        taskId: "task-1",
        taskState,
        getMode: () => "act",
        stateManager: { getGlobalSettingsKey: vi.fn().mockReturnValue(settings) } as never,
        postStateToWebview: vi.fn(async () => undefined),
        say: vi.fn(async () => undefined),
        focusChainSettings: DEFAULT_FOCUS_CHAIN_SETTINGS,
    })
    return { focusChain, taskState, settings }
}

describe("FocusChainManager reminder projection", () => {
    it("injects the configured reminder after the requested number of real API requests", () => {
        const { focusChain, taskState } = manager(2)
        taskState.apiRequestCount = 4

        focusChain.beginRequest()
        expect(focusChain.projectInstructions()).toBe("")

        focusChain.beginRequest()
        expect(focusChain.projectInstructions()).toContain("TODO LIST RECOMMENDED")
        expect(taskState.apiRequestsSinceLastTodoUpdate).toBe(2)
    })

    it("reads the live setting and remains inert when Focus Chain is disabled", () => {
        const { focusChain, taskState, settings } = manager(1, false)

        focusChain.beginRequest()
        expect(focusChain.projectInstructions()).toBe("")
        expect(taskState.apiRequestCount).toBe(0)

        settings.enabled = true
        focusChain.beginRequest()
        expect(focusChain.projectInstructions()).toContain("TODO LIST RECOMMENDED")
    })
})
