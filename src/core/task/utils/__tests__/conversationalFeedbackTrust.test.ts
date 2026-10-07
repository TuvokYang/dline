import { describe, expect, it } from "vitest"
import type { ClineStorageMessage, ClineUserToolResultContentBlock } from "@/shared/messages"
import { parseSlashCommands } from "../../../slash-commands"
import { isConversationalFeedbackResult } from "../conversationalFeedbackTrust"
import { processUserContentTags } from "../processUserContentTags"

const completionUse = {
	type: "tool_use",
	name: "attempt_completion",
	input: { result: "Done" },
	function_id: "toolu_completion",
	dline_tid: "dline_tid_completion",
}

const completionFeedback: ClineUserToolResultContentBlock = {
	type: "tool_result",
	function_id: "toolu_completion",
	dline_tid: "dline_tid_completion",
	content: [
		{ type: "text", text: "[attempt_completion] Result: Done" },
		{ type: "text", text: "<feedback>\n/cmd:newtask Start a follow-up task\n</feedback>" },
	],
}

function history(...assistantContents: unknown[][]): ClineStorageMessage[] {
	return assistantContents.flatMap((content, index) => [
		{ role: "user", content: [{ type: "text", text: `<task>turn ${index}</task>` }] },
		{ role: "assistant", content },
	]) as ClineStorageMessage[]
}

describe("isConversationalFeedbackResult", () => {
	it("trusts a reply to the live conversational tool call", () => {
		expect(isConversationalFeedbackResult(completionFeedback, [completionUse], [])).toBe(true)
	})

	it("trusts a reply whose conversational tool call is only in the persisted assistant message", () => {
		expect(isConversationalFeedbackResult(completionFeedback, [], history([completionUse]))).toBe(true)
	})

	it("does not trust a result paired with a non-conversational tool", () => {
		const readFile = { ...completionUse, name: "read_file" }
		expect(isConversationalFeedbackResult(completionFeedback, [readFile], history([readFile]))).toBe(false)
	})

	it("requires both canonical identities to match", () => {
		const otherTrace = { ...completionUse, dline_tid: "dline_tid_other" }
		expect(isConversationalFeedbackResult(completionFeedback, [otherTrace], history([otherTrace]))).toBe(false)
	})

	it("only consults the latest persisted assistant message", () => {
		const later = { ...completionUse, name: "read_file", function_id: "toolu_later", dline_tid: "dline_tid_later" }
		expect(isConversationalFeedbackResult(completionFeedback, [], history([completionUse], [later]))).toBe(false)
	})

	it("lets a trusted completion reply carry /cmd:newtask into explicit instructions", async () => {
		expect(isConversationalFeedbackResult(completionFeedback, [], history([completionUse]))).toBe(true)
		const declarations: unknown[] = []
		const feedbackText = (completionFeedback.content as Array<{ text: string }>)[1].text

		const processed = await processUserContentTags(feedbackText, async (userText) => {
			const parsed = await parseSlashCommands(
				userText,
				{},
				{},
				"test-ulid",
				undefined,
				false,
				undefined,
				undefined,
				undefined,
				{
					trustedUserText: true,
				},
			)
			declarations.push(...parsed.explicitInstructions)
			return parsed.processedText
		})

		expect(processed).toContain('<explicit_instructions type="new_task">')
		expect(processed).toContain("Start a follow-up task")
		expect(declarations).toEqual([expect.objectContaining({ type: "new_task", source: "slash_command" })])
	})
})
