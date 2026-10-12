import type { ToolUse } from "@core/assistant-message"
import { newTaskToolResponse } from "@core/prompts/commands"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { prepareRegisteredToolAdmission } from "../ToolAdmissionRegistry"

/** The parameters the `/newtask` prompt's example call spells, keyed by tag name. */
function exampleParameters(): Record<string, string> {
    const call = newTaskToolResponse().match(/<new_task>\n([\s\S]*?)\n<\/new_task>/)
    if (!call) throw new Error("the /newtask prompt has no new_task example call")
    return Object.fromEntries([...call[1].matchAll(/<([a-z_]+)>([\s\S]*?)<\/\1>/g)].map(([, name, value]) => [name, value]))
}

function admit(params: Record<string, string>) {
    const block: ToolUse = {
        type: "tool_use",
        name: DlineDefaultTool.NEW_TASK,
        params: params as ToolUse["params"],
        partial: false,
        function_id: "function-new-task",
        dline_tid: "dline-new-task",
        ts: 1,
    }
    return prepareRegisteredToolAdmission({
        canonicalToolName: DlineDefaultTool.NEW_TASK,
        block,
        description: "start a new task",
        snapshot: {
            taskId: "task-new-task-prompt",
            cwd: "/workspace",
            workspaceRoots: ["/workspace"],
            settings: DEFAULT_AUTO_APPROVAL_SETTINGS,
            blanket: {},
        },
        run: async () => undefined,
    })
}

describe("/newtask prompt contract", () => {
    it("shows exactly the parameters new_task admission requires", () => {
        const params = exampleParameters()

        expect(Object.keys(params).length).toBeGreaterThan(0)
        expect(admit(params).outcome).not.toBe("rejected")
        for (const name of Object.keys(params)) {
            const { [name]: _omitted, ...rest } = params
            expect(admit(rest), `the example's <${name}> must be required`).toMatchObject({
                outcome: "rejected",
                rejection: { reason: "invalid_parameters" },
            })
        }
    })
})
