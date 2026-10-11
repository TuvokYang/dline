import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { resolveApprovalKind } from "../../kernel/turn/approval-kind"

const CONVERSATIONAL_TOOLS = [
    DlineDefaultTool.ATTEMPT,
    DlineDefaultTool.QNA_RESPOND,
    DlineDefaultTool.MAKE_PLAN,
    DlineDefaultTool.WORKING_RESPOND,
    // Recorded calls under the former name must not reach the outer approval slot either.
    DlineDefaultTool.LEGACY_ACT_MODE_RESPOND,
    DlineDefaultTool.ASK,
    DlineDefaultTool.GENERATE_REPORT,
    DlineDefaultTool.PHASE_REPORT,
    DlineDefaultTool.LEGACY_STATUS_UPDATE,
    // Handing the conversation to a successor is always the user's choice.
    DlineDefaultTool.NEW_TASK,
] as const

describe("canonical conversational approval", () => {
    it.each([
        undefined,
        { yoloMode: true },
        { approveAll: true },
    ])("keeps handler-owned interactions out of the outer approval slot under blanket=%j", (blanket) => {
        for (const toolName of CONVERSATIONAL_TOOLS) {
            expect(resolveApprovalKind({ toolName, settings: DEFAULT_AUTO_APPROVAL_SETTINGS, blanket }).kind).toBe("none")
        }
    })

    it("keeps new_task out of automatic approval even with every read toggle on", () => {
        const settings = {
            ...DEFAULT_AUTO_APPROVAL_SETTINGS,
            actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, readFiles: true, readFilesExternally: true },
        }

        expect(resolveApprovalKind({ toolName: DlineDefaultTool.NEW_TASK, settings })).toMatchObject({
            kind: "none",
            scope: "conversational",
        })
    })
})
