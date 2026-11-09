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
        interactions: { present: async () => undefined },
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
    // Final presentation and automatic progress are covered by real VS Code E2E.
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
