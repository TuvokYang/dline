import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { resolveApprovalKind } from "../../kernel/turn/approval-kind"

const CONVERSATIONAL_TOOLS = [
	ClineDefaultTool.ATTEMPT,
	ClineDefaultTool.QNA_RESPOND,
	ClineDefaultTool.MAKE_PLAN,
	ClineDefaultTool.ACT_MODE,
	ClineDefaultTool.ASK,
	ClineDefaultTool.GENERATE_REPORT,
	ClineDefaultTool.STATUS_UPDATE,
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
})
