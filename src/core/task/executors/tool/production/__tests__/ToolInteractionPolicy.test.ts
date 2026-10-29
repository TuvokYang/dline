import type { ToolUse } from "@core/assistant-message"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import type { TaskConfig } from "../../../../tools/types/TaskConfig"
import { resolveToolInteractionPolicy } from "../ToolInteractionPolicy"

function block(name: DlineDefaultTool, params: ToolUse["params"]): ToolUse {
    return {
        type: "tool_use",
        name,
        params,
        partial: false,
        function_id: `function-${name}`,
        dline_tid: `tid-${name}`,
        ts: 1,
    }
}

function config(overrides: Partial<TaskConfig> = {}): TaskConfig {
    return {
        mode: "plan",
        yoloModeToggled: true,
        callbacks: {
            say: vi.fn(async () => 1),
            switchToActMode: vi.fn(async () => true),
        },
        messageState: {
            clineMessages: [],
            updateTaskHistory: vi.fn(async () => []),
        },
        ...overrides,
    } as unknown as TaskConfig
}

describe("ToolInteractionPolicy", () => {
    it("owns the YOLO follow-up decision before the handler opens an interaction", async () => {
        const task = config()

        const result = await resolveToolInteractionPolicy(
            task,
            block(DlineDefaultTool.ASK, { question: "Which path?", options: "[]" }),
        )

        expect(result).toContain("Which path?")
        expect(task.callbacks.say).toHaveBeenCalledOnce()
    })

    it("owns the YOLO make_plan mode switch and settles its retained row", async () => {
        const task = config({
            messageState: {
                clineMessages: [{ ts: 1, type: "ask", ask: "make_plan", text: "pending", partial: true }],
                updateTaskHistory: vi.fn(async () => []),
            } as unknown as TaskConfig["messageState"],
        })

        const result = await resolveToolInteractionPolicy(
            task,
            block(DlineDefaultTool.MAKE_PLAN, { response: "# Plan", needs_more_exploration: "false" }),
        )

        expect(result).toBeTruthy()
        expect(task.callbacks.switchToActMode).toHaveBeenCalledOnce()
        expect(task.messageState.clineMessages[0]).toMatchObject({ text: JSON.stringify({ response: "# Plan" }), partial: false })
        expect(task.messageState.updateTaskHistory).toHaveBeenCalledOnce()
    })

    it("delegates ordinary interactions and failed mode switches to the handler", async () => {
        await expect(
            resolveToolInteractionPolicy(
                config({ yoloModeToggled: false }),
                block(DlineDefaultTool.ASK, { question: "Need input", options: "[]" }),
            ),
        ).resolves.toBeUndefined()

        await expect(
            resolveToolInteractionPolicy(
                config({ callbacks: { switchToActMode: vi.fn(async () => false) } as unknown as TaskConfig["callbacks"] }),
                block(DlineDefaultTool.MAKE_PLAN, { response: "# Plan" }),
            ),
        ).resolves.toBeUndefined()
    })
})
