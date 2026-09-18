import { strict as assert } from "node:assert"
import { ClineDefaultTool } from "@shared/tools"
import { describe, it, vi } from "vitest"
import type { ToolUse } from "../../../../assistant-message"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { AttemptCompletionHandler } from "../AttemptCompletionHandler"

/**
 * Create a minimal task config for attempt_completion behavior tests.
 * @param taskState Mutable task state used by the handler.
 * @returns TaskConfig with mocked callbacks and services.
 */
function createConfig(
	taskState: TaskState,
	outcome: { actionId: "reply" | "start_new_task"; text?: string } = { actionId: "start_new_task" },
): TaskConfig {
	const clineMessages: Array<{ type: "say"; say: string; text?: string; ts: number }> = []
	return {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: "e:\\workspace\\vscode\\dline",
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		doubleCheckCompletionEnabled: false,
		vscodeTerminalExecutionMode: "backgroundExec",
		enableParallelToolCalling: false,
		isSubagentExecution: false,
		taskState,
		interactions: {
			open: vi.fn(async () => ({
				actionId: outcome.actionId,
				draft: { text: outcome.text ?? "", images: [], files: [] },
			})),
			complete: vi.fn(async () => ({
				actionId: outcome.actionId,
				draft: { text: outcome.text ?? "", images: [], files: [] },
			})),
			say: vi.fn(async () => undefined),
		},
		taskController: {
			rejectActiveBlock: vi.fn(),
		} as unknown as TaskConfig["taskController"],
		messageState: {
			clineMessages,
			updateClineMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TaskConfig["messageState"],
		api: {
			getModel: () => ({ id: "test-model", info: { supportsImages: false } }),
		} as unknown as TaskConfig["api"],
		autoApprovalSettings: { enableNotifications: false } as unknown as TaskConfig["autoApprovalSettings"],
		browserSettings: {} as unknown as TaskConfig["browserSettings"],
		focusChainSettings: { enabled: false } as unknown as TaskConfig["focusChainSettings"],
		services: {
			stateManager: {
				getGlobalSettingsKey: (key: string) => (key === "hooksEnabled" ? false : undefined),
				getApiConfiguration: () => ({ planModeProfile: "openai", actModeProfile: "openai" }),
			} as unknown,
		} as unknown as TaskConfig["services"],
		coordinator: {} as TaskConfig["coordinator"],
		identityFactory: {
			/** Return a stable result item identity for this fixture. */
			nextItemId: () => "dline_item_attempt_completion_test",
			/** Return a stable trace identity for this fixture. */
			nextTraceId: () => "dline_tid_attempt_completion_test",
		},
		callbacks: {
			say: vi.fn(async (type: string, text?: string) => {
				clineMessages.push({ type: "say", say: type, text, ts: Date.now() })
				return Date.now()
			}),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			saveCheckpoint: vi.fn().mockResolvedValue(undefined),
			doesLatestTaskCompletionHaveNewChanges: vi.fn().mockResolvedValue(false),
			updateFCListFromToolResponse: vi.fn().mockResolvedValue(undefined),
			runUserPromptSubmitHook: vi.fn().mockResolvedValue({}),
		} as unknown as TaskConfig["callbacks"],
	} as unknown as TaskConfig
}

/**
 * Create an attempt_completion tool block for handler execution.
 * @returns Complete attempt_completion tool block.
 */
function createBlock(): ToolUse {
	return {
		type: "tool_use",
		function_id: "completion-function-1",
		name: ClineDefaultTool.ATTEMPT,
		params: { result: "done" },
		partial: false,
		ts: 123,
		dline_tid: "completion-1",
	} as ToolUse
}

describe("AttemptCompletionHandler stop behavior", () => {
	it("returns terminal completion when the runtime starts a new task", async () => {
		const taskState = new TaskState()
		const config = createConfig(taskState)
		const handler = new AttemptCompletionHandler()

		const result = await handler.execute(config, createBlock())

		assert.equal(result, "[attempt_completion] Result: Done")
	})

	it("leaves task_progress updates to the central executor", async () => {
		const taskState = new TaskState()
		const config = createConfig(taskState)
		config.focusChainSettings = { enabled: true } as TaskConfig["focusChainSettings"]
		const block = createBlock()
		block.params.task_progress = "- [x] Verify result"

		await new AttemptCompletionHandler().execute(config, block)

		expect(config.callbacks.updateFCListFromToolResponse).not.toHaveBeenCalled()
	})

	it("returns completion feedback when the user replies", async () => {
		const taskState = new TaskState()
		const config = createConfig(taskState, { actionId: "reply", text: "Please refine the result" })
		const handler = new AttemptCompletionHandler()

		const result = await handler.execute(config, createBlock())

		assert.deepEqual(result, [
			{ type: "text", text: "[attempt_completion] Result: Done" },
			{
				type: "text",
				text: "The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.",
			},
			{ type: "text", text: "<feedback>\nPlease refine the result\n</feedback>" },
		])
	})
})
