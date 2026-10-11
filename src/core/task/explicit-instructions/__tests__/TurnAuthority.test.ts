import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { TaskTurnAuthority } from "../TurnAuthority"
import type { ExplicitInstructionDeclaration } from "../types"

const manualCompact: ExplicitInstructionDeclaration = {
    type: "summarize_task",
    source: "manual_compact_command",
    targetTool: DlineDefaultTool.SUMMARIZE_TASK,
}

describe("TaskTurnAuthority", () => {
    it("grants the turn that admitted the command", () => {
        const authority = new TaskTurnAuthority()

        const granted = authority.grant("turn-1", [manualCompact])

        expect(granted?.turnId).toBe("turn-1")
        expect(authority.read("turn-1")?.getPendingToolAuthorization(DlineDefaultTool.SUMMARIZE_TASK)).toMatchObject({
            type: "summarize_task",
            source: "manual_compact_command",
            state: "pending",
        })
    })

    it("denies a block that belongs to another turn or to none", () => {
        const authority = new TaskTurnAuthority()
        authority.grant("turn-1", [manualCompact])

        expect(authority.read("turn-2")).toBeUndefined()
        expect(authority.read(undefined)).toBeUndefined()
    })

    it("grants nothing when the admitted input named no command", () => {
        const authority = new TaskTurnAuthority()

        expect(authority.grant("turn-1", [])).toBeUndefined()
        expect(authority.read("turn-1")).toBeUndefined()
    })

    it("retires the previous turn so authority never carries over", () => {
        const authority = new TaskTurnAuthority()
        const first = authority.grant("turn-1", [manualCompact])

        authority.grant("turn-2", [])

        expect(authority.read("turn-1")).toBeUndefined()
        expect(first?.port.getPendingToolAuthorization(DlineDefaultTool.SUMMARIZE_TASK)).toBeUndefined()
    })

    it("withdraws authority when the turn that granted it is abandoned", () => {
        const authority = new TaskTurnAuthority()
        const granted = authority.grant("turn-1", [manualCompact])

        granted?.cancel()

        expect(authority.read("turn-1")).toBeUndefined()
        expect(granted?.port.consumeTool(DlineDefaultTool.SUMMARIZE_TASK)).toEqual({
            ok: false,
            code: "explicit_instruction_cancelled",
        })
    })

    it("drops a declaration the policy cannot authorize instead of failing the turn", () => {
        const authority = new TaskTurnAuthority()

        const granted = authority.grant("turn-1", [
            // A replayed payload that lost its target tool, and a duplicate of a
            // target another declaration already claimed.
            { type: "summarize_task", source: "manual_compact_command" },
            manualCompact,
            manualCompact,
        ])

        expect(granted?.turnId).toBe("turn-1")
        expect(authority.read("turn-1")?.getPendingToolAuthorization(DlineDefaultTool.SUMMARIZE_TASK)).toBeDefined()
    })

    it("keeps a behavior declaration that authorizes no tool", () => {
        const authority = new TaskTurnAuthority()

        const granted = authority.grant("turn-1", [{ type: "workflow", source: "workflow_injection" }])

        expect(granted).toBeDefined()
        expect(authority.read("turn-1")?.getPendingToolAuthorization(DlineDefaultTool.SUMMARIZE_TASK)).toBeUndefined()
    })
})
