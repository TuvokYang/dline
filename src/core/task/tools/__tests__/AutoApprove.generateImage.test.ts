import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { resolveApprovalKind } from "../../kernel/turn/approval-kind"

function decision(generateImages?: boolean) {
	return resolveApprovalKind({
		toolName: ClineDefaultTool.GENERATE_IMAGE,
		settings: {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, generateImages },
		},
	})
}

describe("canonical generate_image approval", () => {
	it("defaults to manual approval when the dedicated field is absent", () => {
		expect(decision().kind).toBe("manual")
	})

	it("uses only the dedicated generateImages permission", () => {
		expect(decision(true).kind).toBe("automatic")
		expect(decision(false).kind).toBe("manual")
	})
})
