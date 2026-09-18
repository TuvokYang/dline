import type { ToolUse } from "@core/assistant-message"
import { describe, expect, it, vi } from "vitest"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { NewTaskHandler } from "../NewTaskHandler"

vi.mock("@core/prompts/i18n", () => ({
	getPrompt: vi.fn(() => "New task confirmed"),
}))

vi.mock("@core/prompts/responses", () => ({
	formatResponse: {
		toolResult: vi.fn((text: string, images?: string[], fileContent?: string) =>
			images || fileContent
				? [{ type: "text", text }, ...(images ?? []).map((image) => ({ type: "image", source: image }))]
				: text,
		),
	},
}))

vi.mock("@integrations/misc/extract-text", () => ({
	processFilesIntoText: vi.fn(async (files: string[]) => `files:${files.join(",")}`),
}))

vi.mock("@integrations/notifications", () => ({
	showSystemNotification: vi.fn(),
}))

vi.mock("../../utils/UserFeedbackUtils", () => ({
	sayFeedbackOnce: vi.fn(async () => undefined),
}))

interface InteractionResult {
	actionId: "approve" | "reject"
	text?: string
	images?: string[]
	files?: string[]
}

/** Create a minimal handler configuration with one causal interaction result. */
function createConfig(result: InteractionResult): TaskConfig {
	return {
		taskId: "task-new",
		ulid: "ulid-new",
		cwd: "/workspace",
		mode: "act",
		taskState: new TaskState(),
		autoApprovalSettings: { enableNotifications: false },
		interactions: {
			open: vi.fn(async () => ({
				actionId: result.actionId,
				draft: {
					text: result.text ?? "",
					images: result.images ?? [],
					files: result.files ?? [],
				},
			})),
		},
		callbacks: {
			sayAndCreateMissingParamError: vi.fn(async () => "missing context"),
		} as unknown as TaskConfig["callbacks"],
	} as unknown as TaskConfig
}

/** Create one complete new_task tool block with canonical identity. */
function createBlock(context?: string): ToolUse {
	return {
		type: "tool_use",
		name: "new_task",
		dline_tid: "tid-new-task",
		function_id: "function-new-task",
		ts: 100,
		params: context === undefined ? {} : { context },
		partial: false,
	} as ToolUse
}

describe("NewTaskHandler", () => {
	it("returns a successor directive for approve even when a draft is present", async () => {
		const config = createConfig({ actionId: "approve", text: "This draft must not change the action" })

		const result = await new NewTaskHandler().execute(config, createBlock("Successor task context"))

		expect(result).toMatchObject({
			response: "New task confirmed",
			postCommit: {
				type: "start_successor_task",
				context: "Successor task context",
				functionId: "function-new-task",
				dlineTid: "tid-new-task",
			},
		})
	})

	it("keeps the existing missing-context error path", async () => {
		const config = createConfig({ actionId: "approve" })

		const result = await new NewTaskHandler().execute(config, createBlock())

		expect(result).toBe("missing context")
		expect(config.callbacks.sayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", "context", undefined, 100)
		expect(config.interactions.open).not.toHaveBeenCalled()
	})
})
