import type { ToolUse } from "@core/assistant-message"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { ExecuteCommandToolHandler } from "../ExecuteCommandToolHandler"

function commandBlock(command: string, partial: boolean): ToolUse {
    return {
        type: "tool_use",
        name: DlineDefaultTool.BASH,
        params: { command },
        partial,
        function_id: "fn-1",
        dline_tid: "tid-1",
    } as ToolUse
}

function helpers(say: ReturnType<typeof vi.fn>, isSubagentExecution = false) {
    return {
        say,
        getConfig: () => ({ isSubagentExecution }) as TaskConfig,
        removeClosingTag: (_block: ToolUse, _param: string, text?: string) => text ?? "",
    }
}

describe("ExecuteCommandToolHandler streaming preview", () => {
    // The directory is resolved when the command runs, which has not happened
    // while the call is still streaming. Stating one here would be a guess, so
    // the preview states none and the approval anchor adds it.
    it("streams the command line without inventing a directory", async () => {
        const say = vi.fn(async () => 1)

        await new ExecuteCommandToolHandler().handlePartialBlock(commandBlock("npm test", true), helpers(say) as never)

        expect(say).toHaveBeenCalledOnce()
        const args = say.mock.calls[0] as unknown[]
        expect(args[0]).toBe("command")
        expect(args[1]).toBe("npm test")
        expect(args[4]).toBe(true)
        expect(args[7]).toBeUndefined()
    })

    it("streams nothing for a subagent call", async () => {
        const say = vi.fn(async () => 1)

        await new ExecuteCommandToolHandler().handlePartialBlock(commandBlock("npm test", true), helpers(say, true) as never)

        expect(say).not.toHaveBeenCalled()
    })
})
