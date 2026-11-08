import { Settings, UpdateTaskSettingsRequest } from "@shared/proto/dline/state"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { updateTaskSettings } from "../updateTaskSettings"

function createController() {
    const setTaskSettingsBatch = vi.fn()
    const setTaskSettings = vi.fn()
    const setGlobalState = vi.fn()
    const mutateGlobalSettingsKey = vi.fn()
    const flushPendingState = vi.fn().mockResolvedValue(undefined)
    const rebuild = vi.fn()
    const promptFlush = vi.fn()
    const postStateToWebview = vi.fn().mockResolvedValue(undefined)
    const controller = {
        task: { taskId: "active-task", owners: { api: { rebuild }, prompt: { flush: promptFlush } } },
        stateManager: { setTaskSettingsBatch, setTaskSettings, setGlobalState, mutateGlobalSettingsKey, flushPendingState },
        postStateToWebview,
    } as unknown as Controller
    return {
        controller,
        setTaskSettingsBatch,
        setTaskSettings,
        setGlobalState,
        mutateGlobalSettingsKey,
        rebuild,
        promptFlush,
        postStateToWebview,
    }
}

describe("updateTaskSettings UI language scope", () => {
    it.each(["auto", "en", "zh-CN", "historical-unsupported"])("never writes task preference %s", async (uiLanguage) => {
        const fixture = createController()

        await updateTaskSettings(
            fixture.controller,
            UpdateTaskSettingsRequest.create({ settings: Settings.create({ uiLanguage }) }),
        )

        expect(fixture.setTaskSettingsBatch).not.toHaveBeenCalled()
        expect(fixture.setTaskSettings).not.toHaveBeenCalled()
        expect(fixture.setGlobalState).not.toHaveBeenCalled()
        expect(fixture.mutateGlobalSettingsKey).not.toHaveBeenCalled()
        expect(fixture.rebuild).not.toHaveBeenCalled()
        expect(fixture.promptFlush).not.toHaveBeenCalled()
        expect(fixture.postStateToWebview).toHaveBeenCalledOnce()
    })

    it("filters language and existing global-only ceilings while preserving ordinary task updates", async () => {
        const fixture = createController()

        await updateTaskSettings(
            fixture.controller,
            UpdateTaskSettingsRequest.create({
                taskId: "historical-task",
                settings: Settings.create({
                    uiLanguage: "zh-CN",
                    maxParallelToolCalls: 7,
                    maxParallelSubagents: 3,
                    preferredLanguage: "task-model-language",
                    chatInputSendShortcut: "ctrlEnter",
                }),
            }),
        )

        expect(fixture.setTaskSettingsBatch).toHaveBeenCalledExactlyOnceWith("historical-task", {
            preferredLanguage: "task-model-language",
            chatInputSendShortcut: "ctrlEnter",
        })
        expect(fixture.setTaskSettings).not.toHaveBeenCalled()
        expect(fixture.rebuild).not.toHaveBeenCalled()
        expect(fixture.mutateGlobalSettingsKey).not.toHaveBeenCalled()
    })
})
