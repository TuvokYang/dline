import { describe, expect, it, vi } from "vitest"
import { DlineDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../../types/TaskConfig"
import { WorkingRespondHandler } from "../WorkingRespondHandler"

vi.mock("@core/prompts/responses", () => ({
    formatResponse: { toolResult: vi.fn((text: string) => text) },
}))

function config(mode: "act" | "plan", lastToolName = "read_file"): TaskConfig {
    return {
        mode,
        taskState: { lastToolName, consecutiveMistakeCount: 0 },
        callbacks: { say: vi.fn(async () => undefined), sayAndCreateMissingParamError: vi.fn(async () => "missing") },
    } as unknown as TaskConfig
}

function block(response: string) {
    return { name: DlineDefaultTool.WORKING_RESPOND, ts: 101, params: { response } } as any
}

describe("WorkingRespondHandler", () => {
    it("streams the canonical tool row shape used by the final response", async () => {
        const say = vi.fn(async () => undefined)
        const handler = new WorkingRespondHandler()

        await handler.handlePartialBlock(block("Work in progress"), { removeClosingTag: () => "Work in progress", say } as any)

        expect(say).toHaveBeenCalledWith(
            "tool",
            JSON.stringify({ tool: "actModeRespond", content: "Work in progress" }),
            undefined,
            undefined,
            true,
            101,
        )
    })

    it.each(["act", "plan"] as const)("displays the message without ending the turn in %s mode", async (mode) => {
        const taskConfig = config(mode)

        const result = await new WorkingRespondHandler().execute(taskConfig, block("Reading the planner next"))

        expect(taskConfig.callbacks.say).toHaveBeenCalledWith(
            "tool",
            JSON.stringify({ tool: "actModeRespond", content: "Reading the planner next" }),
            undefined,
            undefined,
            false,
            101,
        )
        expect(String(result)).toContain("Now proceed with your next tool call")
    })

    it.each([
        DlineDefaultTool.WORKING_RESPOND,
        DlineDefaultTool.LEGACY_ACT_MODE_RESPOND,
    ])("blocks a reply that directly follows %s", async (previous) => {
        const taskConfig = config("plan", previous)

        const result = await new WorkingRespondHandler().execute(taskConfig, block("Again"))

        expect(String(result)).toContain("[BLOCKED]")
        expect(taskConfig.callbacks.say).not.toHaveBeenCalled()
    })

    it("answers a reply once user input has broken the tool sequence", async () => {
        const taskConfig = config("act", DlineDefaultTool.WORKING_RESPOND)
        // What the compose round does when the user wrote between the two replies.
        taskConfig.taskState.lastToolName = ""

        const result = await new WorkingRespondHandler().execute(taskConfig, block("Answering your question"))

        expect(String(result)).not.toContain("[BLOCKED]")
        expect(taskConfig.callbacks.say).toHaveBeenCalledOnce()
    })
})
