import type { ToolUse } from "@core/assistant-message"
import type { LoadCapabilityPayload } from "@shared/load-capabilities"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { LoadCapabilityService } from "../../load-capabilities/LoadCapabilityService"
import { LoadCapabilityHandler } from "../LoadCapabilityHandler"

/**
 * Build a minimal TaskConfig for LoadCapabilityHandler tests.
 *
 * @returns Mocked TaskConfig and callback spies.
 */
function createConfig(): {
    config: Parameters<LoadCapabilityHandler["execute"]>[0]
    callbacks: { say: ReturnType<typeof vi.fn>; sayAndCreateMissingParamError: ReturnType<typeof vi.fn> }
} {
    const callbacks = {
        say: vi.fn().mockResolvedValue(undefined),
        sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
    }
    const taskState = {
        consecutiveMistakeCount: 0,
    }
    const config = {
        isSubagentExecution: false,
        taskState,
        callbacks,
    } as unknown as Parameters<LoadCapabilityHandler["execute"]>[0]
    return { config, callbacks }
}

/**
 * Build a parsed tool-use block for load_skill.
 *
 * @param name Optional capability name parameter.
 * @returns Parsed tool-use block.
 */
function createBlock(name?: string): ToolUse {
    return {
        type: "tool_use",
        function_id: "test_load_capability",
        dline_tid: "test_load_capability_tid",
        name: ClineDefaultTool.LOAD_SKILL,
        params: name === undefined ? {} : { name },
        partial: false,
        ts: 123,
    }
}

describe("LoadCapabilityHandler", () => {
    it("returns a missing parameter error when name is absent", async () => {
        const { config, callbacks } = createConfig()
        const handler = new LoadCapabilityHandler(ClineDefaultTool.LOAD_SKILL, "skill")

        const result = await handler.execute(config, createBlock())

        expect(result).toBe("missing")
        expect(callbacks.sayAndCreateMissingParamError).toHaveBeenCalledWith(ClineDefaultTool.LOAD_SKILL, "name", undefined, 123)
        expect(config.taskState.consecutiveMistakeCount).toBe(1)
    })

    it("renders completed payload and returns model-facing details", async () => {
        const { config, callbacks } = createConfig()
        const payload: LoadCapabilityPayload = {
            tool: "loadCapability",
            kind: "skill",
            status: "completed",
            name: "review-code",
            source: "project",
            enabled: true,
            summary: "review-code: Review code",
            details: [{ label: "Source", value: "project" }],
            body: "Follow the review checklist.",
        }
        const service = {
            load: vi.fn().mockResolvedValue(payload),
        } as unknown as LoadCapabilityService
        const handler = new LoadCapabilityHandler(ClineDefaultTool.LOAD_SKILL, "skill", service)

        const result = await handler.execute(config, createBlock("review-code"))

        expect(callbacks.say).toHaveBeenCalledWith("tool", JSON.stringify(payload), undefined, undefined, false, 123)
        expect(result).toContain("# Loaded skill: review-code")
        expect(result).toContain("Follow the review checklist.")
        expect(result).toContain("Follow these instructions directly for the current task")
        expect(result).toContain("Do not call load_skill again for 'review-code'")
        expect(String(result).match(/Follow the review checklist\./g)).toHaveLength(1)
        expect(config.taskState.consecutiveMistakeCount).toBe(0)
    })
})
