import { describe, it, vi } from "vitest"
import "should"
import type { ToolUse } from "@core/assistant-message"
import * as HookExecutor from "@core/hooks/hook-executor"
import { DefaultToolHandlerState } from "@core/task/tools/state/ToolHandlerState"
import { ClineDefaultTool } from "@shared/tools"
// sinon import removed
import { ToolHookUtils } from "../ToolHookUtils"

describe("ToolHookUtils", () => {
    describe("runPreToolUseIfEnabled", () => {
        it("returns early without running hooks when hooks are disabled", async () => {
            const saySpy = vi.fn(async () => Date.now())
            const cancelTaskSpy = vi.fn(async () => {})

            const config: any = {
                taskState: new DefaultToolHandlerState(),
                services: {
                    stateManager: {
                        getGlobalSettingsKey: (key: string) => (key === "hooksEnabled" ? false : undefined),
                    },
                },
                callbacks: {
                    say: saySpy,
                    cancelTask: cancelTaskSpy,
                },
            }

            const block: ToolUse = {
                type: "tool_use",
                function_id: "test_hook_disabled",
                dline_tid: "test_hook_disabled_tid",
                name: ClineDefaultTool.FILE_READ,
                params: { path: "src/index.ts" },
                partial: false,
                ts: Date.now(),
            }

            const shouldContinue = await ToolHookUtils.runPreToolUseIfEnabled(config, block)

            shouldContinue.should.equal(true)
            ;(saySpy.mock.calls.length > 0).should.equal(false)
            ;(cancelTaskSpy.mock.calls.length > 0).should.equal(false)
            config.taskState.userMessageContent.should.have.length(0)
        })

        it("treats undefined hooksEnabled as enabled and runs hook flow", async () => {
            const saySpy = vi.fn(async () => Date.now())
            const executeHookStub = vi.spyOn(HookExecutor, "executeHook").mockResolvedValue({ wasCancelled: false })
            const getGlobalSettingsKeySpy = vi.fn((key: string) => (key === "mode" ? "act" : undefined))
            const getApiConfigurationSpy = vi.fn(() => ({
                actModeProfile: undefined,
                planModeProfile: undefined,
            }))
            const getModelSpy = vi.fn(() => ({ id: "test-model" }))

            const config: any = {
                taskState: new DefaultToolHandlerState(),
                taskId: "test-task-id",
                api: {
                    getModel: getModelSpy,
                },
                messageState: {},
                services: {
                    stateManager: {
                        getGlobalSettingsKey: getGlobalSettingsKeySpy,
                        getApiConfiguration: getApiConfigurationSpy,
                    },
                },
                callbacks: {
                    say: saySpy,
                    cancelTask: async () => {},
                    setActiveHookExecution: async () => {},
                    clearActiveHookExecution: async () => {},
                },
            }

            const block: ToolUse = {
                type: "tool_use",
                function_id: "test_hook_enabled",
                dline_tid: "test_hook_enabled_tid",
                name: ClineDefaultTool.BASH,
                params: { command: "echo hello", requires_approval: "false" },
                partial: false,
                ts: Date.now(),
            }

            try {
                const shouldContinue = await ToolHookUtils.runPreToolUseIfEnabled(config, block)

                shouldContinue.should.equal(true)
                ;(saySpy.mock.calls.length > 0).should.equal(false)
                executeHookStub.mock.calls.length.should.equal(1)
                getGlobalSettingsKeySpy.mock.calls.some((call: any[]) => call[0] === "hooksEnabled").should.equal(true)
                getGlobalSettingsKeySpy.mock.calls.some((call: any[]) => call[0] === "mode").should.equal(true)
                ;(getApiConfigurationSpy.mock.calls.length > 0).should.equal(true)
                ;(getModelSpy.mock.calls.length > 0).should.equal(true)
                config.taskState.userMessageContent.should.have.length(0)
            } finally {
                executeHookStub.mockRestore()
            }
        })
    })
})
