import type { ToolUse } from "@core/assistant-message"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { createCanonicalAskRow } from "../../../ask-row"
import { approvalInteractionId } from "../../approval-interaction"
import type { TaskConfig } from "../../types/TaskConfig"
import { ExecuteCommandToolHandler } from "../ExecuteCommandToolHandler"

function commandBlock(dlineTid: string): ToolUse {
	return {
		type: "tool_use",
		name: ClineDefaultTool.BASH,
		params: { command: "npm test" },
		partial: false,
		function_id: `fn-${dlineTid}`,
		dline_tid: dlineTid,
	} as ToolUse
}

function configWith(messages: ReturnType<typeof createCanonicalAskRow>[]) {
	const updateClineMessage = vi.fn(async () => undefined)
	const config = {
		messageState: { clineMessages: messages },
		callbacks: { updateClineMessage },
	} as unknown as TaskConfig
	return { config, updateClineMessage }
}

describe("ExecuteCommandToolHandler.presentDenial", () => {
	// A refused command never runs, so its approval row must stop offering a
	// running state; the row is found by the approval's own interaction id.
	it("marks the refused command's approval row skipped and leaves a sibling's pending row alone", async () => {
		const sibling = createCanonicalAskRow("command", "npm run build", 1, approvalInteractionId("tid-sibling"))
		const refused = createCanonicalAskRow("command", "npm test", 2, approvalInteractionId("tid-refused"))
		const { config, updateClineMessage } = configWith([refused, sibling])

		await new ExecuteCommandToolHandler().presentDenial(config, commandBlock("tid-refused"))

		expect(updateClineMessage).toHaveBeenCalledExactlyOnceWith(0, { commandStatus: "skipped" })
	})

	it("still finds an approval row restored from a task that keyed it by the bare call id", async () => {
		const legacy = createCanonicalAskRow("command", "npm test", 1, "tid-legacy")
		const { config, updateClineMessage } = configWith([legacy])

		await new ExecuteCommandToolHandler().presentDenial(config, commandBlock("tid-legacy"))

		expect(updateClineMessage).toHaveBeenCalledExactlyOnceWith(0, { commandStatus: "skipped" })
	})
})
