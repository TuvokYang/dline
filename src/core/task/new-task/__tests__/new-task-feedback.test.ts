import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it, vi } from "vitest"
import { NEW_TASK_FEEDBACK_CONTINUATION_MARKER } from "../new-task-continuation"
import { buildNewTaskFeedbackContent, findLatestNewTaskFeedback } from "../new-task-feedback"

vi.mock("@integrations/misc/extract-text", () => ({
	processFilesIntoContent: vi.fn(async (files: string[]) => [{ type: "text", text: `files:${files.join(",")}` }]),
}))

function assistantNewTask(functionId: string, dlineTid: string): ClineStorageMessage {
	return {
		role: "assistant",
		content: [{ type: "tool_use", name: "new_task", input: {}, function_id: functionId, dline_tid: dlineTid }],
	}
}

function feedbackResult(functionId: string, dlineTid: string, text: string): ClineStorageMessage {
	return {
		role: "user",
		content: [
			{
				type: "tool_result",
				function_id: functionId,
				dline_tid: dlineTid,
				content: `${NEW_TASK_FEEDBACK_CONTINUATION_MARKER}\n<feedback>\n${text}\n</feedback>`,
			},
		],
	}
}

describe("New Task successor feedback", () => {
	it("inherits only the canonical feedback request immediately preceding the approved declaration", () => {
		const apiHistory: ClineStorageMessage[] = [
			assistantNewTask("function-feedback", "tid-feedback"),
			feedbackResult("function-feedback", "tid-feedback", "Use the narrower migration boundary"),
			assistantNewTask("function-approved", "tid-approved"),
		]
		const uiHistory: ClineMessage[] = [
			{
				ts: 100,
				type: "say",
				say: "user_feedback",
				text: "Use the narrower migration boundary",
				images: ["data:image/png;base64,AAAA"],
				files: ["notes.md"],
				interactionId: "tid-feedback",
			},
		]

		expect(
			findLatestNewTaskFeedback({
				apiHistory,
				uiHistory,
				approvedSource: { functionId: "function-approved", dlineTid: "tid-approved" },
			}),
		).toEqual({
			text: "Use the narrower migration boundary",
			images: ["data:image/png;base64,AAAA"],
			files: ["notes.md"],
		})
	})

	it("does not inherit stale feedback when another user request precedes approval", () => {
		const apiHistory: ClineStorageMessage[] = [
			assistantNewTask("function-feedback", "tid-feedback"),
			feedbackResult("function-feedback", "tid-feedback", "Old feedback"),
			{ role: "user", content: [{ type: "text", text: "ordinary request" }] },
			assistantNewTask("function-approved", "tid-approved"),
		]

		expect(
			findLatestNewTaskFeedback({
				apiHistory,
				uiHistory: [],
				approvedSource: { functionId: "function-approved", dlineTid: "tid-approved" },
			}),
		).toEqual({ text: "", images: [], files: [] })
	})

	it("fails closed when the approved declaration identity is absent", () => {
		expect(
			findLatestNewTaskFeedback({
				apiHistory: [assistantNewTask("function-feedback", "tid-feedback")],
				uiHistory: [],
				approvedSource: { functionId: "forged", dlineTid: "forged" },
			}),
		).toEqual({ text: "", images: [], files: [] })
	})

	it("encodes feedback and attachments as independent successor input blocks", async () => {
		const content = await buildNewTaskFeedbackContent({
			text: "Keep the migration boundary",
			images: ["data:image/png;base64,AAAA"],
			files: ["notes.md"],
		})

		expect(content[0]).toEqual({ type: "text", text: "<feedback>\nKeep the migration boundary\n</feedback>" })
		expect(content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]))
		expect(content).toEqual(expect.arrayContaining([{ type: "text", text: "files:notes.md" }]))
	})
})
