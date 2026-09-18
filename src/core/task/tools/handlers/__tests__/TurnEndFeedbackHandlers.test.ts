import { strict as assert } from "node:assert"
import type { ToolUse } from "@core/assistant-message"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { AskFollowupQuestionToolHandler } from "../AskFollowupQuestionToolHandler"
import { GenerateReportHandler } from "../GenerateReportHandler"
import { MakePlanHandler } from "../MakePlanHandler"

vi.mock("@/services/telemetry", () => ({
	telemetryService: {
		captureOptionSelected: vi.fn(),
		captureOptionsIgnored: vi.fn(),
		captureTaskCompleted: vi.fn(),
	},
}))

/**
 * Create a minimal task config for turn-end feedback handler tests.
 * @param text User feedback text returned by the ask callback.
 * @returns TaskConfig test double with stable ask and state dependencies.
 */
function createConfig(text: string): TaskConfig {
	const taskState = new TaskState()
	taskState.ackedFeedback = {
		response: "messageResponse",
		text,
		images: [],
		files: [],
	}

	const callbacks: TaskConfig["callbacks"] = {
		ask: vi.fn(async () => ({ response: "messageResponse" as const, text, images: [], files: [] })),
		say: vi.fn(async () => Date.now()),
		focusChainForceUpdate: vi.fn(async () => {}),
		saveCheckpoint: vi.fn(async () => {}),
		sayAndCreateMissingParamError: vi.fn(async () => "missing param"),
		executeCommandTool: vi.fn(async () => ({
			userRejected: false,
			result: "",
			completed: true,
			exitCode: 0,
			signal: null,
		})),
		doesLatestTaskCompletionHaveNewChanges: vi.fn(async () => false),
		updateFCListFromToolResponse: vi.fn(async () => {}),
		postStateToWebview: vi.fn(async () => {}),
		reinitExistingTaskFromId: vi.fn(async () => {}),
		cancelTask: vi.fn(async () => {}),
		updateTaskHistory: vi.fn(async () => []),
		applyLatestBrowserSettings: vi.fn(async () => ({}) as ReturnType<TaskConfig["callbacks"]["applyLatestBrowserSettings"]>),
		switchToActMode: vi.fn(async () => false),
		setActiveHookExecution: vi.fn(async () => {}),
		clearActiveHookExecution: vi.fn(async () => {}),
		getActiveHookExecution: vi.fn(async () => undefined),
		runUserPromptSubmitHook: vi.fn(async () => ({})),
		updateClineMessage: vi.fn(async () => {}),
	}

	return {
		taskId: "task-turn-end",
		ulid: "ulid-turn-end",
		cwd: "/workspace",
		mode: "plan",
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		doubleCheckCompletionEnabled: false,
		vscodeTerminalExecutionMode: "vscodeTerminal",
		enableParallelToolCalling: false,
		isSubagentExecution: false,
		taskState,
		taskController: {} as TaskConfig["taskController"],
		messageState: Object.assign(Object.create(null), {
			clineMessages: [],
			updateTaskHistory: vi.fn(async () => []),
			updateClineMessage: vi.fn(async () => {}),
			flushMessageUpdate: vi.fn(async () => {}),
		}) as TaskConfig["messageState"],
		api: Object.assign(Object.create(null), {
			getModel: vi.fn(() => ({ id: "model", info: {} })),
		}) as TaskConfig["api"],
		services: {
			mcpHub: {} as TaskConfig["services"]["mcpHub"],
			browserSession: {} as TaskConfig["services"]["browserSession"],
			urlContentFetcher: {} as TaskConfig["services"]["urlContentFetcher"],
			diffViewProvider: {} as TaskConfig["services"]["diffViewProvider"],
			fileContextTracker: {} as TaskConfig["services"]["fileContextTracker"],
			taskFileTracker: {} as TaskConfig["services"]["taskFileTracker"],
			ignoreController: {} as TaskConfig["services"]["ignoreController"],
			commandPermissionController: {} as TaskConfig["services"]["commandPermissionController"],
			contextManager: {} as TaskConfig["services"]["contextManager"],
			stateManager: Object.assign(Object.create(null), {
				getGlobalSettingsKey: vi.fn(() => "plan"),
				getApiConfiguration: vi.fn(() => ({})),
			}) as TaskConfig["services"]["stateManager"],
			imageGenerationService: {} as TaskConfig["services"]["imageGenerationService"],
		},
		autoApprovalSettings: { enableNotifications: false } as TaskConfig["autoApprovalSettings"],
		browserSettings: {} as TaskConfig["browserSettings"],
		focusChainSettings: {} as TaskConfig["focusChainSettings"],
		capabilityToggles: createTaskCapabilityToggles({}),
		interactions: {
			open: vi.fn(async () => ({ actionId: "reply" as const, draft: { text, images: [], files: [] } })),
			complete: vi.fn(async () => ({ actionId: "reply" as const, draft: { text, images: [], files: [] } })),
			say: vi.fn(async () => {}),
		},
		callbacks,
		coordinator: {} as TaskConfig["coordinator"],
		identityFactory: {
			/** Return a stable result item identity for this fixture. */
			nextFunctionId: () => "dline_function_turn_end_test",
			/** Return a stable trace identity for this fixture. */
			nextTraceId: () => "dline_tid_turn_end_test",
		},
	}
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((release) => {
		resolve = release
	})
	return { promise, resolve }
}

/**
 * Create a tool-use block for a turn-end handler.
 * @param name Tool name.
 * @param params Tool parameters.
 * @returns ToolUse block with stable timestamp.
 */
function createBlock(name: string, params: Record<string, string>): ToolUse {
	return {
		type: "tool_use",
		name,
		params,
		partial: false,
		ts: 100,
		dline_tid: `tid-${name}`,
	} as ToolUse
}

describe("turn-ending feedback handlers", () => {
	it("durably persists a restored follow-up option before continuation resolves", async () => {
		const selected = "Use the second option"
		const config = createConfig(selected)
		const handler = new AskFollowupQuestionToolHandler()
		const originalText = JSON.stringify({ question: "Which option?", options: ["Use the first option", selected] })
		config.messageState.clineMessages.push(
			{ ts: 1, type: "ask", ask: "followup", text: "older follow-up" },
			{ ts: 2, type: "say", say: "text", text: "between asks" },
			{ ts: 3, type: "ask", ask: "followup", text: originalText },
		)
		const flush = createDeferred()
		const updateClineMessage = vi.mocked(config.callbacks.updateClineMessage)
		const flushMessageUpdate = vi.mocked(config.messageState.flushMessageUpdate).mockImplementation(() => flush.promise)
		let resolved = false

		const continuation = handler
			.continueInteraction(
				config,
				createBlock(ClineDefaultTool.ASK, {
					question: "Which option?",
					options: JSON.stringify(["Use the first option", selected]),
				}),
				{ actionId: "reply", draft: { text: selected, images: [], files: [] } },
			)
			.then((result) => {
				resolved = true
				return result
			})

		await vi.waitFor(() => expect(flushMessageUpdate).toHaveBeenCalledOnce())
		expect(updateClineMessage).toHaveBeenCalledWith(2, {
			text: JSON.stringify({
				question: "Which option?",
				options: ["Use the first option", selected],
				selected,
			}),
		})
		expect(updateClineMessage.mock.invocationCallOrder[0]).toBeLessThan(flushMessageUpdate.mock.invocationCallOrder[0])
		expect(config.messageState.clineMessages[2].text).toBe(originalText)
		expect(resolved).toBe(false)

		flush.resolve()
		await continuation
		expect(resolved).toBe(true)
		expect(config.callbacks.say).not.toHaveBeenCalledWith("user_feedback", selected, [], [])
		expect(config.messageState.updateTaskHistory).not.toHaveBeenCalled()
	})

	it("persists the selected follow-up option while preserving its attached draft in the tool result", async () => {
		const selected = "Use the second option"
		const response = `${selected}: Keep the compatibility layer`
		const config = createConfig(response)
		config.taskState.ackedFeedback = undefined
		const handler = new AskFollowupQuestionToolHandler()
		config.messageState.clineMessages.push({
			ts: 3,
			type: "ask",
			ask: "followup",
			text: JSON.stringify({ question: "Which option?", options: ["Use the first option", selected] }),
		})

		const result = await handler.continueInteraction(
			config,
			createBlock(ClineDefaultTool.ASK, {
				question: "Which option?",
				options: JSON.stringify(["Use the first option", selected]),
			}),
			{ actionId: "reply", draft: { text: response, images: [], files: [] } },
		)

		expect(config.callbacks.updateClineMessage).toHaveBeenCalledWith(0, {
			text: JSON.stringify({
				question: "Which option?",
				options: ["Use the first option", selected],
				selected,
			}),
		})
		expect(config.callbacks.say).toHaveBeenCalledOnce()
		expect(config.callbacks.say).toHaveBeenCalledWith("user_feedback", response, [], [])
		expect(result).toContain(`<feedback>\n${response}\n</feedback>`)
	})

	it("opens the canonical make_plan interaction without legacy options", async () => {
		const config = createConfig("Adjust the plan")
		const handler = new MakePlanHandler()

		await handler.execute(config, createBlock(ClineDefaultTool.MAKE_PLAN, { response: "Choose a plan" }))

		expect(config.interactions.open).toHaveBeenCalledWith({
			turnId: "turn:tid-make_plan",
			interactionId: "tid-make_plan",
			kind: "make_plan",
			presentation: JSON.stringify({ response: "Choose a plan" }),
			existingTs: 100,
		})
	})

	it("make_plan returns feedback wrapper and avoids duplicate UI feedback", async () => {
		const config = createConfig("请按方案二调整")
		const handler = new MakePlanHandler()

		const result = await handler.execute(config, createBlock(ClineDefaultTool.MAKE_PLAN, { response: "方案" }))

		expect(config.callbacks.say).not.toHaveBeenCalledWith("user_feedback", "请按方案二调整", [], [])
		assert.ok(typeof result === "string")
		assert.match(result, /<feedback>\n请按方案二调整\n<\/feedback>/)
		assert.doesNotMatch(result, /<user_message>/)
	})

	it("generate_report returns feedback wrapper and avoids duplicate UI feedback", async () => {
		const config = createConfig("报告里补充风险")
		const handler = new GenerateReportHandler()

		const result = await handler.execute(
			config,
			createBlock(ClineDefaultTool.GENERATE_REPORT, { title: "报告", content: "内容" }),
		)

		expect(config.callbacks.say).not.toHaveBeenCalledWith("user_feedback", "报告里补充风险", [], [])
		assert.ok(typeof result === "string")
		assert.match(result, /<feedback>\n报告里补充风险\n<\/feedback>/)
		assert.doesNotMatch(result, /<user_message>/)
	})

	it("ask_followup_question returns feedback wrapper and avoids duplicate UI feedback", async () => {
		const config = createConfig("我选择自定义答案")
		const handler = new AskFollowupQuestionToolHandler()

		const result = await handler.execute(config, createBlock(ClineDefaultTool.ASK, { question: "继续吗？", options: "[]" }))

		expect(config.callbacks.say).not.toHaveBeenCalledWith("user_feedback", "我选择自定义答案", [], [])
		assert.ok(typeof result === "string")
		assert.match(result, /<feedback>\n我选择自定义答案\n<\/feedback>/)
		assert.doesNotMatch(result, /<answer>/)
	})
})
