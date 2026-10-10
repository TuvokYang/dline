/**
 * Unit tests for SpawnTaskHandler — covers all execution paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import "should"
import type { ToolUse } from "@core/assistant-message"
import { ClineDefaultTool } from "@/shared/tools"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import type { TaskConfig } from "../../types/TaskConfig"
import { SpawnTaskHandler } from "../SpawnTaskHandler"

function createTaskState(consecutiveMistakeCount = 0): DefaultToolHandlerState {
    const state = new DefaultToolHandlerState()
    state.consecutiveMistakeCount = consecutiveMistakeCount
    return state
}

describe("SpawnTaskHandler", () => {
    const handler = new SpawnTaskHandler()

    beforeEach(() => {
        vi.clearAllMocks()
    })

    describe("basic properties", () => {
        it("should have name SPAWN_TASK", () => {
            handler.name.should.equal(ClineDefaultTool.SPAWN_TASK)
        })

        it("should return description with spawn_task tag", () => {
            const desc = handler.getDescription({ name: "spawn_task" } as unknown as ToolUse)
            desc.should.match(/\[spawn_task\]/)
        })
    })

    describe("execute — missing task parameter", () => {
        it("should call sayAndCreateMissingParamError when task is missing", async () => {
            let called = false
            const config = {
                taskId: "parent-1",
                taskState: createTaskState(),
                callbacks: {
                    sayAndCreateMissingParamError: async (_toolName: string, _param: string) => {
                        called = true
                        return "Missing param error"
                    },
                    ask: async () => ({ response: "no" }),
                    say: async () => {},
                },
                services: { stateManager: {} },
            } as unknown as TaskConfig

            await handler.execute(config, { name: "spawn_task", params: {} } as unknown as ToolUse)
            called.should.be.true()
            config.taskState.consecutiveMistakeCount.should.equal(1)
        })
    })

    describe("execute — task param provided", () => {
        it("should reset mistake count when task is provided", async () => {
            const config = {
                taskId: "parent-1",
                taskState: createTaskState(5),
                taskController: { rejectActiveBlock: () => {} },
                interactions: {
                    open: async () => ({ actionId: "reject" }),
                },
                callbacks: {
                    ask: async () => ({ response: "noButtonClicked" }),
                    say: async () => {},
                },
                services: { stateManager: {} },
            } as unknown as TaskConfig

            await handler.execute(config, {
                name: "spawn_task",
                dline_tid: "tid-reset",
                params: { task: "Test task", mode: "plan" },
            } as unknown as ToolUse)
            config.taskState.consecutiveMistakeCount.should.equal(0)
        })

        it("should report a missing mode when task is provided without one", async () => {
            const sayAndCreateMissingParamError = vi.fn(async () => "Missing mode error")
            const config = {
                taskState: createTaskState(),
                callbacks: { sayAndCreateMissingParamError },
            } as unknown as TaskConfig

            const result = await handler.execute(config, {
                name: "spawn_task",
                dline_tid: "tid-missing-mode",
                params: { task: "Test task" },
            } as unknown as ToolUse)

            expect(result).toBe("Missing mode error")
            expect(config.taskState.consecutiveMistakeCount).toBe(1)
            expect(sayAndCreateMissingParamError).toHaveBeenCalledWith("spawn_task", "mode", undefined, undefined)
        })

        it("should reject an unsupported mode before opening approval", async () => {
            const open = vi.fn()
            const config = {
                taskState: createTaskState(),
                interactions: { open },
            } as unknown as TaskConfig

            const result = await handler.execute(config, {
                name: "spawn_task",
                dline_tid: "tid-invalid-mode",
                params: { task: "Test task", mode: "review" },
            } as unknown as ToolUse)

            expect(result).toMatch(/Invalid mode 'review'/)
            expect(config.taskState.consecutiveMistakeCount).toBe(1)
            expect(open).not.toHaveBeenCalled()
        })
    })

    describe("execute — approved spawn", () => {
        it.each([
            ["plan", "parent-plan-profile"],
            ["act", "parent-act-profile"],
        ] as const)("starts the child in %s mode without waiting for its task loop", async (requestedMode, expectedProfile) => {
            const spawn = vi.fn(async () => ({ childTaskId: "child-1" }))
            const config = {
                taskId: "parent-1",
                mode: "plan",
                taskState: createTaskState(),
                callbacks: { say: async () => {} },
                services: {
                    stateManager: {
                        getApiConfigurationForTask: () => ({
                            planModeProfile: "parent-plan-profile",
                            actModeProfile: "parent-act-profile",
                        }),
                    },
                },
                peerTaskSpawner: { spawn },
            } as unknown as TaskConfig

            const execution = handler.execute(config, {
                name: "spawn_task",
                dline_tid: "tid-background",
                params: { task: "Background child", mode: requestedMode, context: "Context" },
            } as unknown as ToolUse)
            const result = await Promise.race([
                execution,
                new Promise<string>((resolve) => setTimeout(() => resolve("SPAWN_BLOCKED"), 25)),
            ])

            expect(result).not.toBe("SPAWN_BLOCKED")
            expect(result).toContain(`${requestedMode.toUpperCase()} task`)
            expect(result).toContain("child-1")
            expect(spawn).toHaveBeenCalledWith({
                task: "Background child",
                mode: requestedMode,
                profile: expectedProfile,
                context: "Context",
                signal: config.taskState.operationSignal,
            })
        })

        it("reports an error when the host-owned peer spawner fails", async () => {
            const spawn = vi.fn(async () => {
                throw new Error("init failed")
            })
            const config = {
                taskId: "parent-1",
                mode: "plan",
                taskState: createTaskState(),
                interactions: { open: async () => ({ actionId: "approve" }) },
                callbacks: { say: async () => {} },
                services: {
                    stateManager: {
                        getApiConfiguration: () => ({ planModeProfile: "parent-profile" }),
                        getApiConfigurationForTask: () => ({ planModeProfile: "parent-profile" }),
                        getGlobalSettingsKey: () => "plan",
                    },
                },
                peerTaskSpawner: { spawn },
            } as unknown as TaskConfig

            const result = await handler.execute(config, {
                name: "spawn_task",
                dline_tid: "tid-init-error",
                params: { task: "Failing child", mode: "plan" },
            } as unknown as ToolUse)

            expect(result).toMatch(/init failed/i)
            expect(spawn).toHaveBeenCalledOnce()
        })
    })

    describe("execute — error handling", () => {
        it("should return toolError when an exception occurs", async () => {
            const config = {
                taskId: "parent-1",
                taskState: createTaskState(),
                interactions: {
                    open: async () => ({ actionId: "approve" }),
                },
                callbacks: {
                    ask: async () => ({ response: "yesButtonClicked" }),
                    say: async () => {},
                },
                services: { stateManager: {} },
                peerTaskSpawner: undefined,
            } as unknown as TaskConfig

            const result = await handler.execute(config, {
                name: "spawn_task",
                dline_tid: "tid-error",
                params: { task: "Test task", mode: "plan" },
            } as unknown as ToolUse)

            result.should.match(/spawn task failed/i)
        })
    })
})
