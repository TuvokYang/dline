import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { TaskState } from "../../TaskState"
import { ActModeRespondHandler } from "../../tools/handlers/ActModeRespondHandler"
import { ExecuteCommandToolHandler } from "../../tools/handlers/ExecuteCommandToolHandler"
import { FocusChainHandler } from "../../tools/handlers/FocusChainHandler"
import { QnaRespondHandler } from "../../tools/handlers/QnaRespondHandler"
import { SpawnTaskHandler } from "../../tools/handlers/SpawnTaskHandler"
import { StatusUpdateHandler } from "../../tools/handlers/StatusUpdateHandler"
import type { TaskConfig } from "../../tools/types/TaskConfig"

vi.mock("@core/prompts/i18n", () => ({
	getPrompt: vi.fn(() => "prompt"),
	renderPrompt: vi.fn(() => "prompt"),
}))

vi.mock("@core/prompts/responses", () => ({
	formatResponse: {
		toolResult: vi.fn((text: string) => text),
		toolDenied: vi.fn(() => "denied"),
		toolError: vi.fn((text: string) => text),
	},
}))

vi.mock("@integrations/notifications", () => ({
	showApprovalNotification: vi.fn(async () => undefined),
	showSystemNotification: vi.fn(),
}))

vi.mock("../../tools/utils/ToolHookUtils", () => ({
	ToolHookUtils: { runPreToolUseIfEnabled: vi.fn(async () => undefined) },
}))

/** Create one stable tool-use block. */
function block(name: ClineDefaultTool, params: Record<string, string>): ToolUse {
	return {
		type: "tool_use",
		name,
		params,
		partial: false,
		ts: 100,
		function_id: `function-${name}`,
		dline_tid: `tid-${name}`,
	} as ToolUse
}

/** Create a focused handler configuration with typed interaction ports. */
function config(
	outcome: { actionId: string; text?: string; selection?: string[] } = { actionId: "reply", text: "feedback" },
): TaskConfig {
	const open = vi.fn(async () => ({
		actionId: outcome.actionId,
		draft: { text: outcome.text ?? "", images: [], files: [] },
		selection: outcome.selection ? { values: outcome.selection } : undefined,
	}))
	return {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: process.cwd(),
		mode: "act",
		isSubagentExecution: false,
		taskState: Object.assign(new TaskState(), { lastToolName: "read_file" }),
		interactions: { open, complete: open, say: vi.fn(async () => undefined) },
		admissionOutcomes: new Map([
			[
				`tid-${ClineDefaultTool.CHANGE_TODO_LIST}`,
				{
					actionId: outcome.actionId,
					draft: { text: outcome.text ?? "", images: [], files: [] },
					selection: outcome.selection ? { values: outcome.selection } : undefined,
				},
			],
		]),
		callbacks: {
			askAsk: vi.fn(async () => {
				throw new Error("legacy ask must not be called")
			}),
			say: vi.fn(async () => 100),
			sayAndCreateMissingParamError: vi.fn(async () => "missing"),
			focusChainForceUpdate: vi.fn(async () => undefined),
			updateClineMessage: vi.fn(async () => undefined),
		} as unknown as TaskConfig["callbacks"],
		messageState: { clineMessages: [], updateTaskHistory: vi.fn(async () => []) } as unknown as TaskConfig["messageState"],
		taskController: { rejectActiveBlock: vi.fn() } as unknown as TaskConfig["taskController"],
		autoApprovalSettings: { actions: { focusChain: false } } as TaskConfig["autoApprovalSettings"],
	} as unknown as TaskConfig
}

describe("handler interaction matrix", () => {
	it("opens Q&A as qna_response", async () => {
		const taskConfig = config()
		await new QnaRespondHandler().execute(taskConfig, block(ClineDefaultTool.QNA_RESPOND, { response: "Answer" }))
		expect(taskConfig.interactions.open).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "qna_response", presentation: JSON.stringify({ response: "Answer" }) }),
		)
	})

	it("leaves act_mode_respond task_progress updates to the central executor", async () => {
		const taskConfig = config()
		taskConfig.callbacks.updateFCListFromToolResponse = vi.fn(async () => undefined)

		await new ActModeRespondHandler().execute(
			taskConfig,
			block(ClineDefaultTool.ACT_MODE, {
				response: "Starting implementation",
				task_progress: "# Plan\n- [ ] Implement",
			}),
		)

		expect(taskConfig.callbacks.updateFCListFromToolResponse).not.toHaveBeenCalled()
	})

	it("opens acknowledged status as status_acknowledgment", async () => {
		const taskConfig = config({ actionId: "acknowledge", text: "ok" })
		await new StatusUpdateHandler().execute(
			taskConfig,
			block(ClineDefaultTool.STATUS_UPDATE, { response: "Checkpoint", requires_acknowledgment: "true" }),
		)
		expect(taskConfig.interactions.open).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "status_acknowledgment", presentation: "Checkpoint" }),
		)
	})

	it("presents non-acknowledged status as say only", async () => {
		const taskConfig = config()
		await new StatusUpdateHandler().execute(
			taskConfig,
			block(ClineDefaultTool.STATUS_UPDATE, { response: "Working", requires_acknowledgment: "false" }),
		)
		expect(taskConfig.interactions.say).toHaveBeenCalledWith(
			expect.objectContaining({
				taskSay: "tool",
				presentation: JSON.stringify({ tool: "statusUpdate", content: "Working" }),
			}),
		)
		expect(taskConfig.interactions.open).not.toHaveBeenCalled()
	})

	it("does not open spawn approval inside the admitted handler", async () => {
		const taskConfig = config({ actionId: "reject" })
		await new SpawnTaskHandler().execute(
			taskConfig,
			block(ClineDefaultTool.SPAWN_TASK, { task: "Child", mode: "plan", context: "Context" }),
		)
		expect(taskConfig.interactions.open).not.toHaveBeenCalled()
	})

	it("executes an admitted command without opening another approval", async () => {
		const taskConfig = config({ actionId: "approve" })
		Object.assign(taskConfig, {
			api: { getModel: vi.fn(() => ({ id: "test-model" })) },
			services: {
				stateManager: {
					getApiConfiguration: vi.fn(() => ({})),
					getGlobalSettingsKey: vi.fn(() => "act"),
				},
				commandPermissionController: { validateCommand: vi.fn(() => ({ allowed: true })) },
				ignoreController: { validateDirectoryAccess: vi.fn(() => true), validateCommand: vi.fn(() => undefined) },
			},
			autoApprover: { shouldAutoApproveTool: vi.fn(() => [false, false]) },
			autoApprovalSettings: { enableNotifications: false },
			isMultiRootEnabled: false,
		})
		taskConfig.callbacks.ask = vi.fn(async () => ({ response: "yesButtonClicked" as const }))
		taskConfig.callbacks.executeCommandTool = vi.fn(async () => ({
			userRejected: false,
			result: "ok",
			completed: true,
			exitCode: 0,
			signal: null,
		}))

		await new ExecuteCommandToolHandler().execute(
			taskConfig,
			block(ClineDefaultTool.BASH, { command: "echo ok", requires_approval: "true" }),
		)

		expect(taskConfig.interactions.open).not.toHaveBeenCalled()
		expect(taskConfig.callbacks.executeCommandTool).toHaveBeenCalled()
	})

	it("forces external workdirectories through approval and executes without a cd prefix", async () => {
		const boundaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-command-boundary-"))
		const workspaceDirectory = path.join(boundaryRoot, "workspace")
		const externalDirectory = path.join(boundaryRoot, "external")
		await Promise.all([fs.mkdir(workspaceDirectory), fs.mkdir(externalDirectory)])
		try {
			const taskConfig = config({ actionId: "approve" })
			Object.assign(taskConfig, {
				cwd: workspaceDirectory,
				api: { getModel: vi.fn(() => ({ id: "test-model" })) },
				services: {
					stateManager: {
						getApiConfiguration: vi.fn(() => ({})),
						getGlobalSettingsKey: vi.fn(() => "act"),
					},
					commandPermissionController: { validateCommand: vi.fn(() => ({ allowed: true })) },
					ignoreController: {
						validateDirectoryAccess: vi.fn(() => true),
						validateCommand: vi.fn(() => undefined),
					},
				},
				autoApprover: { shouldAutoApproveTool: vi.fn(() => [true, true]) },
				autoApprovalSettings: { enableNotifications: false },
				isMultiRootEnabled: false,
			})
			taskConfig.callbacks.executeCommandTool = vi.fn(async () => ({
				userRejected: false,
				result: "ok",
				completed: true,
				exitCode: 0,
				signal: null,
			}))

			await new ExecuteCommandToolHandler().execute(
				taskConfig,
				block(ClineDefaultTool.BASH, {
					command: "echo ok",
					requires_approval: "false",
					workdirectory: externalDirectory,
				}),
			)

			const canonicalDirectory = await fs.realpath(externalDirectory)
			expect(taskConfig.interactions.open).not.toHaveBeenCalled()
			expect(taskConfig.callbacks.executeCommandTool).toHaveBeenCalledWith(
				"echo ok",
				expect.any(Number),
				expect.objectContaining({ workdirectory: canonicalDirectory }),
			)
		} finally {
			await fs.rm(boundaryRoot, { recursive: true, force: true })
		}
	})

	it("reads the latest command timeout setting for each launch in the current task", async () => {
		let configuredTimeout = 1800
		const taskConfig = config({ actionId: "approve" })
		Object.assign(taskConfig, {
			api: { getModel: vi.fn(() => ({ id: "test-model" })) },
			services: {
				stateManager: {
					getApiConfiguration: vi.fn(() => ({})),
					getGlobalSettingsKey: vi.fn((key: string) =>
						key === "mode" ? "act" : key === "terminalCommandTimeoutSeconds" ? configuredTimeout : undefined,
					),
				},
				commandPermissionController: { validateCommand: vi.fn(() => ({ allowed: true })) },
				ignoreController: { validateDirectoryAccess: vi.fn(() => true), validateCommand: vi.fn(() => undefined) },
			},
			autoApprover: { shouldAutoApproveTool: vi.fn(() => [true, true]) },
			autoApprovalSettings: { enableNotifications: false },
			isMultiRootEnabled: false,
		})
		taskConfig.callbacks.executeCommandTool = vi.fn(async () => ({
			userRejected: false,
			result: "ok",
			completed: true,
			exitCode: 0,
			signal: null,
		}))

		await new ExecuteCommandToolHandler().execute(
			taskConfig,
			block(ClineDefaultTool.BASH, { command: "echo first", requires_approval: "false" }),
		)
		configuredTimeout = 3600
		await new ExecuteCommandToolHandler().execute(
			taskConfig,
			block(ClineDefaultTool.BASH, { command: "echo second", requires_approval: "false", synchronous: "true" }),
		)

		expect(taskConfig.callbacks.executeCommandTool).toHaveBeenNthCalledWith(
			1,
			"echo first",
			1800,
			expect.objectContaining({ synchronous: false }),
		)
		expect(taskConfig.callbacks.executeCommandTool).toHaveBeenNthCalledWith(
			2,
			"echo second",
			3600,
			expect.objectContaining({ synchronous: true }),
		)
	})

	it("terminates only the execute_command identified by function_id", async () => {
		const taskConfig = config()
		taskConfig.callbacks.killCommandTool = vi.fn(async () => ({
			activityId: "command-activity",
			cancelled: true,
			command: "npm install",
		}))

		await new ExecuteCommandToolHandler(ClineDefaultTool.KILL_COMMAND).execute(
			taskConfig,
			block(ClineDefaultTool.KILL_COMMAND, { function_id: "function-execute-command" }),
		)

		expect(taskConfig.callbacks.killCommandTool).toHaveBeenCalledWith("function-execute-command")
		expect(taskConfig.callbacks.say).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "killCommand",
				path: "npm install",
				content: "prompt",
				activityId: "command-activity",
			}),
			undefined,
			undefined,
			false,
			100,
		)
	})

	it("rejects interaction opening without canonical dline identity", async () => {
		const taskConfig = config()
		const missingIdentity = block(ClineDefaultTool.QNA_RESPOND, { response: "Answer" })
		delete (missingIdentity as Partial<typeof missingIdentity>).dline_tid

		await expect(new QnaRespondHandler().execute(taskConfig, missingIdentity)).rejects.toThrow(
			"Canonical tool interaction is missing dlineTid",
		)
		expect(taskConfig.interactions.open).not.toHaveBeenCalled()
	})

	it("rejects a TODO list replacement without any valid items", async () => {
		const taskConfig = config()
		const result = await new FocusChainHandler().execute(
			taskConfig,
			block(ClineDefaultTool.CHANGE_TODO_LIST, { new_plan: "# Empty plan\n## Phase", reason: "Change" }),
		)

		expect(result).toBe("prompt")
		expect(taskConfig.interactions.open).not.toHaveBeenCalled()
		expect(taskConfig.callbacks.focusChainForceUpdate).not.toHaveBeenCalled()
	})

	it("rejects a TODO list replacement without the required Title", async () => {
		const taskConfig = config()
		const result = await new FocusChainHandler().execute(
			taskConfig,
			block(ClineDefaultTool.CHANGE_TODO_LIST, { new_plan: "## Phase\n- [ ] First", reason: "Change" }),
		)

		expect(result).toBe("prompt")
		expect(taskConfig.interactions.open).not.toHaveBeenCalled()
		expect(taskConfig.callbacks.focusChainForceUpdate).not.toHaveBeenCalled()
	})

	it("keeps the current TODO list when no proposed items are approved", async () => {
		const taskConfig = config({ actionId: "approve", selection: [] })
		const result = await new FocusChainHandler().execute(
			taskConfig,
			block(ClineDefaultTool.CHANGE_TODO_LIST, { new_plan: "# Plan\n- [ ] First", reason: "Change" }),
		)

		expect(result).toBe("prompt")
		expect(taskConfig.callbacks.focusChainForceUpdate).not.toHaveBeenCalled()
	})

	it("applies TODO-list selection with canonical block identity", async () => {
		const taskConfig = config({ actionId: "approve", selection: ["1"] })
		const focusChainForceUpdate = taskConfig.callbacks.focusChainForceUpdate
		await new FocusChainHandler().execute(
			taskConfig,
			block(ClineDefaultTool.CHANGE_TODO_LIST, { new_plan: "# Plan\n- [ ] First\n- [ ] Second", reason: "Change" }),
		)
		expect(taskConfig.interactions.open).not.toHaveBeenCalled()
		expect(focusChainForceUpdate).toHaveBeenCalledWith("# Plan\n- [ ] Second")
	})
})
