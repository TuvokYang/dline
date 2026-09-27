import { strict as assert } from "node:assert"
import { setTimeout as delay } from "node:timers/promises"
import type { ToolUse } from "@core/assistant-message"
// sinon import removed: using vitest globals
import * as ApiProfilesModule from "@core/controller/file/getApiProfiles"
import { telemetryService } from "@services/telemetry"
import { MAX_SUBAGENTS_PER_BATCH } from "@shared/concurrency-limits"
import { ClineSubagentUsageInfo } from "@shared/ExtensionMessage"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import type { TaskActivityEventInput } from "@shared/task-activity"
import { ClineDefaultTool } from "@shared/tools"
import { expect } from "chai"
import { afterEach, describe, it, vi, expect as vitestExpect } from "vitest"
import { TaskActivityStore } from "../../../activity/TaskActivityStore"
import { TaskState } from "../../../TaskState"
import type { ResolvedAgentConfig } from "../../subagent/AgentConfigLoader"
import * as AgentConfigModule from "../../subagent/AgentConfigLoader"
import { SubagentBuilder } from "../../subagent/SubagentBuilder"
import { SubagentRunner, type SubagentRunResult } from "../../subagent/SubagentRunner"
import type { TaskConfig } from "../../types/TaskConfig"
import { createUIHelpers } from "../../types/UIHelpers"
import {
	buildStatusPayload,
	restoreSubagentActivityRetry,
	UseSubagentsToolHandler as UseSubagentsToolHandlerImpl,
	UseSubagentToolHandler as UseSubagentToolHandlerImpl,
} from "../SubagentToolHandler"

type TestToolUse = Omit<ToolUse, "function_id" | "dline_tid"> & Partial<Pick<ToolUse, "function_id" | "dline_tid">>

class UseSubagentsToolHandler extends UseSubagentsToolHandlerImpl {
	override execute(config: TaskConfig, block: TestToolUse) {
		return super.execute(config, {
			...block,
			function_id: block.function_id ?? "test_subagents_function",
			dline_tid: block.dline_tid ?? "test_subagents_tid",
		})
	}

	override handlePartialBlock(block: TestToolUse, uiHelpers: ReturnType<typeof createUIHelpers>) {
		return super.handlePartialBlock(
			{
				...block,
				function_id: block.function_id ?? "test_subagents_function",
				dline_tid: block.dline_tid ?? "test_subagents_tid",
			},
			uiHelpers,
		)
	}
}

class UseSubagentToolHandler extends UseSubagentToolHandlerImpl {
	override execute(config: TaskConfig, block: TestToolUse) {
		return super.execute(config, {
			...block,
			function_id: block.function_id ?? "test_subagent_function",
			dline_tid: block.dline_tid ?? "test_subagent_tid",
		})
	}
}

type MockSubagentBuilder = {
	getApiHandler: () => object
	getAllowedTools: () => never[]
	getConfiguredSkills: () => undefined
}

// Mock SubagentBuilder to avoid buildApiHandler (requires API profile config)
vi.mock("../../subagent/SubagentBuilder", () => ({
	SubagentBuilder: vi.fn(function (this: MockSubagentBuilder) {
		this.getApiHandler = () => ({})
		this.getAllowedTools = () => []
		this.getConfiguredSkills = () => undefined
	}),
}))

/**
 * Present a Profile catalogue in which the named Profiles are usable by
 * subagents. Without this the on-disk catalogue is empty, which is itself the
 * "Profile no longer available" case.
 *
 * @param names Profile names that should resolve and be enabled.
 */
function stubEnabledProfiles(names: string[]): void {
	vi.spyOn(ApiProfilesModule, "readApiProfiles").mockReturnValue(
		names.map((name) => ({ id: name, name, enabled: true, usedFor: ["subagents"] })) as never,
	)
}

/**
 * Read the mocked builder so a test can inspect the agent config a runner was
 * constructed with. The builder is the point where a resolved Profile becomes
 * an API handler, so its third argument is the observable binding.
 */
function vitestMockedBuilder(): ReturnType<typeof vi.fn> {
	return SubagentBuilder as unknown as ReturnType<typeof vi.fn>
}

function createConfig(options?: {
	autoApproveSafe?: boolean
	autoApproveAll?: boolean
	taskAskResponse?: "yesButtonClicked" | "noButtonClicked"
	subagentsEnabled?: boolean
	maxParallelSubagents?: number
}) {
	const taskState = new TaskState()
	const askResponse = options?.taskAskResponse ?? "yesButtonClicked"
	const subagentsEnabled = options?.subagentsEnabled ?? true

	const callbacks = {
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: askResponse }),
		saveCheckpoint: vi.fn().mockResolvedValue(undefined),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
		executeCommandTool: vi
			.fn()
			.mockResolvedValue({ userRejected: false, result: "ok", completed: true, exitCode: 0, signal: null }),
		cancelRunningCommandTool: vi.fn().mockResolvedValue(false),
		doesLatestTaskCompletionHaveNewChanges: vi.fn().mockResolvedValue(false),
		updateFCListFromToolResponse: vi.fn().mockResolvedValue(undefined),
		shouldAutoApproveTool: vi.fn().mockReturnValue([options?.autoApproveSafe ?? false, options?.autoApproveAll ?? false]),
		shouldAutoApproveToolWithPath: vi.fn().mockResolvedValue(false),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		reinitExistingTaskFromId: vi.fn().mockResolvedValue(undefined),
		cancelTask: vi.fn().mockResolvedValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue([]),
		applyLatestBrowserSettings: vi.fn().mockResolvedValue(undefined),
		switchToActMode: vi.fn().mockResolvedValue(false),
		setActiveHookExecution: vi.fn().mockResolvedValue(undefined),
		clearActiveHookExecution: vi.fn().mockResolvedValue(undefined),
		getActiveHookExecution: vi.fn().mockResolvedValue(undefined),
		runUserPromptSubmitHook: vi.fn().mockResolvedValue({}),
	}

	const config = {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: "/tmp",
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		vscodeTerminalExecutionMode: "backgroundExec",
		enableParallelToolCalling: true,
		context: {},
		taskState,
		taskController: { rejectActiveBlock: vi.fn() },
		messageState: {},
		api: {
			getModel: () => ({ id: "openai/gpt-5", info: {} }),
		},
		autoApprovalSettings: {
			enableNotifications: false,
			actions: {
				executeSafeCommands: false,
				executeAllCommands: false,
			},
		},
		autoApprover: {
			shouldAutoApproveTool: vi.fn().mockReturnValue([options?.autoApproveSafe ?? false, options?.autoApproveAll ?? false]),
		},
		browserSettings: {},
		focusChainSettings: {},
		capabilityToggles: createTaskCapabilityToggles({}),
		services: {
			stateManager: {
				getGlobalStateKey: (key: string) => (key === "nativeToolCallEnabled" ? true : undefined),
				getGlobalSettingsKey: (key: string) => {
					if (key === "mode") {
						return "act"
					}
					if (key === "customPrompt") {
						return undefined
					}
					if (key === "subagentsEnabled") {
						return subagentsEnabled
					}
					if (key === "maxParallelSubagents") {
						return options?.maxParallelSubagents
					}
					return undefined
				},
				getApiConfiguration: () => ({
					planModeProfile: "openai",
					actModeProfile: "openai",
				}),
			},
			mcpHub: {},
		},
		callbacks,
		coordinator: {
			getHandler: vi.fn(),
		},
	} as unknown as TaskConfig

	return { config, callbacks, taskState }
}

function emptyTestStats() {
	return {
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalCost: 0,
		currency: "USD",
		contextTokens: 0,
		contextWindow: 200000,
		contextUsagePercentage: 0,
	}
}

describe("SubagentToolHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("uses real injection state in Webview status payload", () => {
		const payload = buildStatusPayload(
			"single",
			"completed",
			[
				{
					index: 1,
					prompt: "<task>review</task><context>ctx</context>",
					status: "completed",
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					currency: "USD",
					contextTokens: 0,
					contextWindow: 0,
					contextUsagePercentage: 0,
					injectionState: "consumed",
				},
			],
			{ background: true, timeoutSeconds: 30, jobId: "subagent_1", injectionState: "consumed" },
		)

		assert.equal(payload.injectionState, "consumed")
		assert.equal(payload.items[0].injectionState, "consumed")
	})

	it("returns missing parameter error when no prompts are provided", async () => {
		const { config, callbacks, taskState } = createConfig()
		const handler = new UseSubagentsToolHandler()

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {},
			partial: false,
			ts: Date.now(),
		})

		assert.ok(String(result).includes("Missing required parameter: subagents"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
		expect(callbacks.sayAndCreateMissingParamError)
	})

	it("returns an error when subagents are disabled", async () => {
		const { config } = createConfig({ subagentsEnabled: false })
		const handler = new UseSubagentsToolHandler()

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([{ task: "one", context: "ctx one" }]),
			},
			partial: false,
			ts: Date.now(),
		})

		assert.equal(
			result,
			"The tool execution failed with the following error:\n<error>\nSubagents are disabled. Enable them in Settings > Features to use this tool.\n</error>",
		)
	})

	it("streams partial use_subagents as presentation without opening approval", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: false, autoApproveAll: false })
		const handler = new UseSubagentsToolHandler()
		const uiHelpers = createUIHelpers(config)

		await handler.handlePartialBlock(
			{
				type: "tool_use",
				name: ClineDefaultTool.USE_SUBAGENTS,
				params: {
					subagents: JSON.stringify([
						{ task: "first", context: "ctx first" },
						{ task: "second", context: "ctx second" },
					]),
				},
				partial: true,
				ts: Date.now(),
			},
			uiHelpers,
		)

		vitestExpect(callbacks.say).toHaveBeenCalledWith(
			"use_subagents",
			vitestExpect.any(String),
			undefined,
			undefined,
			true,
			vitestExpect.any(Number),
		)
		vitestExpect(callbacks.ask).not.toHaveBeenCalled()

		const payload = JSON.parse(callbacks.say.mock.calls[0][1])
		assert.deepEqual(payload.prompts, [
			"<task>\nfirst\n</task>\n<context>\nctx first\n</context>",
			"<task>\nsecond\n</task>\n<context>\nctx second\n</context>",
		])
		expect(callbacks.say)
	})

	it("streams partial use_subagents approval as say when auto-approved", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true, autoApproveAll: false })
		const handler = new UseSubagentsToolHandler()
		const uiHelpers = createUIHelpers(config)

		await handler.handlePartialBlock(
			{
				type: "tool_use",
				name: ClineDefaultTool.USE_SUBAGENTS,
				params: {
					subagents: JSON.stringify([
						{ task: "first", context: "ctx first" },
						{ task: "second", context: "ctx second" },
					]),
				},
				partial: true,
				ts: Date.now(),
			},
			uiHelpers,
		)

		vitestExpect(callbacks.say).toHaveBeenCalledWith(
			"use_subagents",
			vitestExpect.any(String),
			undefined,
			undefined,
			true,
			vitestExpect.any(Number),
		)

		const payload = JSON.parse(callbacks.say.mock.calls[0][1])
		assert.deepEqual(payload.prompts, [
			"<task>\nfirst\n</task>\n<context>\nctx first\n</context>",
			"<task>\nsecond\n</task>\n<context>\nctx second\n</context>",
		])
		expect(callbacks.ask)
	})

	it("uses read-file auto-approve level (safe only) for approval bypass", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true, autoApproveAll: false })
		vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "done",
			stats: {
				toolCalls: 1,
				inputTokens: 2,
				outputTokens: 3,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.25,
				currency: "USD",
				contextTokens: 5,
				contextWindow: 200000,
				contextUsagePercentage: 0.0025,
			},
		})

		const handler = new UseSubagentsToolHandler()
		await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([{ task: "one", context: "ctx one" }]),
			},
			partial: false,
			ts: Date.now(),
		})

		expect(callbacks.ask)
		const subagentStatusCalls = callbacks.say.mock.calls.filter((call) => call[0] === "subagent")
		assert.ok(subagentStatusCalls.length >= 1)
	})

	it("fans out prompts in parallel and emits aggregated status", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		let activeRuns = 0
		let maxActiveRuns = 0

		vi.spyOn(SubagentRunner.prototype, "run").mockImplementation(async (_prompt: string, onProgress) => {
			activeRuns++
			maxActiveRuns = Math.max(maxActiveRuns, activeRuns)
			onProgress({
				status: "running",
				stats: {
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					currency: "USD",
					contextTokens: 0,
					contextWindow: 200000,
					contextUsagePercentage: 0,
				},
			})
			await delay(10)
			activeRuns--
			return {
				status: "completed",
				result: "done",
				stats: {
					toolCalls: 1,
					inputTokens: 2,
					outputTokens: 3,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.25,
					currency: "USD",
					contextTokens: 5,
					contextWindow: 200000,
					contextUsagePercentage: 0.0025,
				},
			}
		})

		const handler = new UseSubagentsToolHandler()
		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([
					{ task: "one", context: "ctx one" },
					{ task: "two", context: "ctx two" },
					{ task: "three", context: "ctx three" },
				]),
			},
			partial: false,
			ts: Date.now(),
		})

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Total: 3"))
		assert.ok(maxActiveRuns > 1)

		const subagentStatusCalls = callbacks.say.mock.calls.filter((call) => call[0] === "subagent")
		assert.ok(subagentStatusCalls.length >= 2)
		const runningCall = subagentStatusCalls.find((call) => JSON.parse(call[1]).status === "running")
		assert.ok(runningCall, "should emit the foreground running status")
		assert.equal(runningCall[4], false, "foreground running status must be published to the Webview")
		const finalCall = subagentStatusCalls[subagentStatusCalls.length - 1]
		assert.equal(finalCall[4], false)

		const usageCalls = callbacks.say.mock.calls.filter((call) => call[0] === "subagent_usage")
		assert.equal(usageCalls.length, 1)
		const usagePayload = JSON.parse(usageCalls[0][1]) as ClineSubagentUsageInfo
		assert.equal(usagePayload.source, "subagents")
		assert.equal(usagePayload.tokensIn, 6)
		assert.equal(usagePayload.tokensOut, 9)
		assert.equal(usagePayload.cacheWrites, 0)
		assert.equal(usagePayload.cacheReads, 0)
		assert.equal(usagePayload.cost, 0.75)
	})

	it("continues after per-subagent failures and reports both outcomes", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })

		vi.spyOn(SubagentRunner.prototype, "run").mockImplementation(async (prompt: string) => {
			if (prompt.includes("fail")) {
				return {
					status: "failed",
					error: "boom",
					stats: {
						toolCalls: 1,
						inputTokens: 0,
						outputTokens: 0,
						cacheWriteTokens: 0,
						cacheReadTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 200000,
						contextUsagePercentage: 0,
					},
				}
			}
			return {
				status: "completed",
				result: "ok",
				stats: {
					toolCalls: 2,
					inputTokens: 0,
					outputTokens: 0,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					currency: "USD",
					contextTokens: 0,
					contextWindow: 200000,
					contextUsagePercentage: 0,
				},
			}
		})

		const handler = new UseSubagentsToolHandler()
		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([
					{ task: "succeed", context: "ctx succeed" },
					{ task: "fail", context: "ctx fail" },
				]),
			},
			partial: false,
			ts: Date.now(),
		})

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Succeeded: 1"))
		assert.ok((result as string).includes("Failed: 1"))
		assert.ok((result as string).includes("boom"))
	})

	it("retains only a retryable foreground batch item and injects its recovered result", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		const setRetry = vi.fn()
		config.activityStore = {
			create: vi.fn(),
			update: vi.fn(),
			appendEvent: vi.fn(),
			setRetry,
			setCancel: vi.fn(),
			setFinish: vi.fn(),
		} as unknown as TaskConfig["activityStore"]
		let retryAttempt = 0
		vi.spyOn(SubagentRunner.prototype, "run").mockImplementation(async (prompt: string) => {
			if (prompt.includes("retry")) {
				retryAttempt += 1
				if (retryAttempt === 1) {
					return {
						status: "failed",
						error: "sensitive provider diagnostic",
						retryable: true,
						stats: { ...emptyTestStats(), toolCalls: 1 },
					}
				}
				return {
					status: "completed",
					result: "recovered batch item",
					stats: { ...emptyTestStats(), toolCalls: 2 },
				}
			}
			return {
				status: "completed",
				result: "stable item",
				stats: emptyTestStats(),
			}
		})

		const result = await new UseSubagentsToolHandler().execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([
					{ task: "stable", context: "ctx" },
					{ task: "retry", context: "ctx" },
				]),
			},
			partial: false,
			ts: Date.now(),
		})

		assert.doesNotMatch(String(result), /sensitive provider diagnostic/)
		assert.match(String(result), /Retryable API failure/)
		assert.match(String(result), /user can restart it with the Retry control/i)
		assert.match(String(result), /do not treat this failure as a completed result/i)
		assert.equal(config.subagentJobManager?.listJobs().length, 1)
		assert.equal(config.subagentJobManager?.listInjectableResults().length, 0)
		const retryRegistration = setRetry.mock.calls.find(([, callback]) => typeof callback === "function")
		assert.ok(retryRegistration)
		assert.equal(await retryRegistration[1](), true)
		await vi.waitFor(() => assert.equal(config.subagentJobManager?.listJobs()[0]?.status, "completed"))
		const [injectable] = config.subagentJobManager?.listInjectableResults() ?? []
		assert.equal(injectable?.kind, "single")
		if (injectable?.kind !== "single") assert.fail("recovered foreground batch item should inject as one job")
		assert.equal(injectable.job.result, "recovered batch item")
		assert.equal(injectable.job.task, "retry")
	})

	it("reports cancelled batch entries without counting them as successes", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true, autoApproveAll: true })

		vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "cancelled",
			error: "Subagent run cancelled.",
			stats: {
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				currency: "USD",
				contextTokens: 0,
				contextWindow: 200000,
				contextUsagePercentage: 0,
			},
		})

		const handler = new UseSubagentsToolHandler()
		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([
					{ task: "one", context: "ctx one" },
					{ task: "two", context: "ctx two" },
					{ task: "three", context: "ctx three" },
				]),
			},
			partial: false,
			ts: Date.now(),
		})

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Succeeded: 0"))
		assert.ok((result as string).includes("Failed: 0"))
		assert.ok((result as string).includes("Cancelled: 3"))

		const subagentStatusCalls = callbacks.say.mock.calls.filter((call) => call[0] === "subagent")
		const finalPayload = JSON.parse(subagentStatusCalls.at(-1)?.[1])
		assert.equal(finalPayload.status, "cancelled")
		assert.equal(finalPayload.successes, 0)
		assert.equal(finalPayload.failures, 0)
	})

	it("runs stable use_subagent with the built-in default when no YAML exists", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		const handler = new UseSubagentToolHandler()
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue(undefined)
		const runStub = vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "default done",
			stats: {
				toolCalls: 1,
				inputTokens: 2,
				outputTokens: 3,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.1,
				currency: "USD",
				contextTokens: 100,
				contextWindow: 200000,
				contextUsagePercentage: 0.05,
			},
		})

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENT,
			params: { task: "review this PR", context: "check quality" },
			partial: false,
			ts: Date.now(),
		})

		assert.match(String(result), /default done/)
		assert.equal(runStub.mock.calls.length, 1)
		const runningCall = callbacks.say.mock.calls.find(
			(call) => call[0] === "subagent" && JSON.parse(call[1]).status === "running",
		)
		assert.ok(runningCall, "should emit the foreground running status")
		assert.equal(runningCall[4], false, "foreground running status must be published to the Webview")
	})

	it("binds the activity before persisting subagent tool and retry events", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		const lifecycle: string[] = []
		const createActivity = vi.fn((input: { activityId: string }) => {
			lifecycle.push(`create:${input.activityId}`)
		})
		const appendEvent = vi.fn((jobId: string, event: TaskActivityEventInput) => {
			lifecycle.push(`append:${jobId}`)
			return event
		})
		config.activityStore = {
			create: createActivity,
			update: vi.fn(),
			appendEvent,
		} as unknown as TaskConfig["activityStore"]
		const handler = new UseSubagentToolHandler()
		vi.spyOn(SubagentRunner.prototype, "run").mockImplementation(async (_prompt, onProgress) => {
			onProgress({
				event: {
					kind: "tool_call",
					toolCallId: "first-tool",
					toolName: "read_file",
					toolStatus: "completed",
					summary: "read_file(path=README.md)",
				},
			})
			onProgress({
				event: {
					kind: "retry",
					retryAttempt: 1,
					maxRetries: 5,
					delayMs: 5_000,
					cumulativeDelayMs: 5_000,
				},
			})
			return {
				status: "completed",
				result: "event persisted",
				stats: {
					toolCalls: 1,
					inputTokens: 1,
					outputTokens: 1,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					currency: "USD",
					contextTokens: 2,
					contextWindow: 200000,
					contextUsagePercentage: 0.001,
				},
			}
		})

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENT,
			params: { task: "review", context: "ctx" },
			partial: false,
			ts: Date.now(),
		})

		assert.match(String(result), /event persisted/)
		assert.equal(createActivity.mock.calls.length, 1)
		assert.equal(appendEvent.mock.calls.length, 2)
		const jobId = createActivity.mock.calls[0][0].activityId
		assert.equal(appendEvent.mock.calls[0][0], jobId)
		assert.equal(appendEvent.mock.calls[1][0], jobId)
		assert.deepEqual(lifecycle, [`create:${jobId}`, `append:${jobId}`, `append:${jobId}`])
		assert.deepEqual(appendEvent.mock.calls[0][1], {
			kind: "tool_call",
			toolCallId: "first-tool",
			toolName: "read_file",
			toolStatus: "completed",
			summary: "read_file(path=README.md)",
			durationMs: undefined,
			error: undefined,
		})
		assert.deepEqual(appendEvent.mock.calls[1][1], {
			kind: "retry",
			retryAttempt: 1,
			maxRetries: 5,
			delayMs: 5_000,
			cumulativeDelayMs: 5_000,
		})
	})

	// The runner reports its terminal status through onProgress as soon as the
	// run resolves. Ignoring it left a finished subagent rendered as `running`
	// until the job manager published the authoritative record.
	it("publishes the terminal status reported through progress before the run resolves", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		const statuses: unknown[] = []
		config.activityStore = {
			create: vi.fn(),
			update: vi.fn((_activityId: string, patch: { status?: unknown }) => {
				if (patch.status !== undefined) statuses.push(patch.status)
			}),
			appendEvent: vi.fn(),
		} as unknown as TaskConfig["activityStore"]
		const handler = new UseSubagentToolHandler()
		vi.spyOn(SubagentRunner.prototype, "run").mockImplementation(async (_prompt, onProgress) => {
			onProgress({ status: "running" })
			onProgress({ status: "completed", result: "terminal status published" })
			return {
				status: "completed",
				result: "terminal status published",
				stats: {
					toolCalls: 0,
					inputTokens: 1,
					outputTokens: 1,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					currency: "USD",
					contextTokens: 2,
					contextWindow: 200000,
					contextUsagePercentage: 0.001,
				},
			}
		})

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENT,
			params: { task: "review", context: "ctx" },
			partial: false,
			ts: Date.now(),
		})

		assert.match(String(result), /terminal status published/)
		assert.equal(statuses.includes("running"), true, "the running status must still be published")
		assert.equal(statuses.includes("completed"), true, "the terminal status must reach the activity store")
		assert.equal(statuses.indexOf("completed") > statuses.indexOf("running"), true)
	})

	it("refuses a restored retry whose recorded Profile is no longer usable", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		config.taskState.abort = true
		const activityStore = new TaskActivityStore("task-1")
		activityStore.create({
			activityId: "subagent-dead-profile",
			kind: "subagent",
			executionMode: "background",
			title: "reviewer",
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "reviewer",
				profileName: "deleted-profile",
				task: "review",
				prompt: "<task>review</task><context>ctx</context>",
				timeoutSeconds: 30,
				retryable: true,
			},
		})
		activityStore.update("subagent-dead-profile", { status: "failed", error: "temporary provider failure" })
		config.activityStore = activityStore
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue({
			config: { name: "reviewer", profile: "slow-reviewer" },
			source: "project",
			path: "test-reviewer.md",
		} as unknown as ResolvedAgentConfig)
		// The catalogue no longer contains the Profile the item ran with.
		stubEnabledProfiles(["slow-reviewer"])
		const builderCallsBefore = vitestMockedBuilder().mock.calls.length

		assert.equal(
			await restoreSubagentActivityRetry(config, "subagent-dead-profile"),
			false,
			"a retry must not silently fall back to another Profile",
		)
		assert.equal(vitestMockedBuilder().mock.calls.length, builderCallsBefore, "no runner may be built")
		assert.match(
			String(activityStore.get("subagent-dead-profile")?.retryUnavailableReason),
			/API Profile 'deleted-profile' is no longer available/,
		)
	})

	it("keeps rejected items visible in a mixed batch approval and summary", async () => {
		// Manual approval is required so the approval payload is observable.
		const { config, callbacks } = createConfig({ autoApproveSafe: false, autoApproveAll: false })
		// Only `reviewer` resolves, so the `missing` item is planned out but the
		// user and the model must still be told it was requested.
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockImplementation(async (_cwd, agentName) =>
			agentName === "reviewer"
				? {
						config: { name: "reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" },
						source: "project",
						path: "/workspace/.agents/subagents/reviewer.yml",
					}
				: undefined,
		)
		vi.spyOn(AgentConfigModule, "listEnabledAgentConfigs").mockResolvedValue([
			{
				config: { name: "reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" },
				source: "project",
				path: "/workspace/.agents/subagents/reviewer.yml",
			},
		])
		vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "done",
			stats: {
				toolCalls: 1,
				inputTokens: 1,
				outputTokens: 1,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				currency: "USD",
				contextTokens: 1,
				contextWindow: 200000,
				contextUsagePercentage: 0,
			},
		})

		const handler = new UseSubagentsToolHandler()
		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([
					{ agent_name: "reviewer", task: "runs", context: "ctx runs" },
					{ agent_name: "missing", task: "never runs", context: "ctx missing" },
				]),
			},
			partial: false,
			ts: Date.now(),
		})

		const approvalCall = callbacks.say.mock.calls.find((call: unknown[]) => call[0] === "use_subagents")
		assert.ok(approvalCall, "an admitted mixed batch must still be presented")
		const approvalPayload = JSON.parse(String(approvalCall[1])) as {
			items?: unknown[]
			rejected?: Array<{ index: number; error: string }>
		}
		assert.equal(approvalPayload.items?.length, 1, "only the runnable item is approved for execution")
		assert.equal(approvalPayload.rejected?.length, 1, "the rejected item must remain visible on the approval card")
		assert.match(String(approvalPayload.rejected?.[0]?.error), /Unknown or disabled subagent 'missing'/)

		assert.match(String(result), /Unknown or disabled subagent 'missing'/)
		assert.match(String(result), /were not started/)
	})

	it("reports rejected items in the tool result of a background mixed batch", async () => {
		// A background batch returns before the runs finish, so the early tool
		// result is the only place the model learns an item was refused.
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockImplementation(async (_cwd, agentName) =>
			agentName === "reviewer"
				? {
						config: { name: "reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" },
						source: "project",
						path: "/workspace/.agents/subagents/reviewer.yml",
					}
				: undefined,
		)
		vi.spyOn(AgentConfigModule, "listEnabledAgentConfigs").mockResolvedValue([
			{
				config: { name: "reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" },
				source: "project",
				path: "/workspace/.agents/subagents/reviewer.yml",
			},
		])
		vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "done",
			stats: {
				toolCalls: 1,
				inputTokens: 1,
				outputTokens: 1,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				currency: "USD",
				contextTokens: 1,
				contextWindow: 200000,
				contextUsagePercentage: 0,
			},
		})

		const handler = new UseSubagentsToolHandler()
		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([
					{ agent_name: "reviewer", task: "runs", context: "ctx runs" },
					{ agent_name: "missing", task: "never runs", context: "ctx missing" },
				]),
				background: "true",
			},
			partial: false,
			ts: Date.now(),
		})

		assert.match(String(result), /Started background subagent batch job/)
		assert.match(String(result), /Unknown or disabled subagent 'missing'/)
		assert.match(String(result), /were not started/)
	})

	it("executes the frozen batch plan when the Profile catalogue changes after preparation", async () => {
		// The approved object is the prepared agent/profile binding. A later
		// catalogue change must not re-plan or silently fall back to another Profile.
		const { config, callbacks } = createConfig({ autoApproveSafe: false, autoApproveAll: false })
		stubEnabledProfiles(["fast-reviewer"])
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue({
			config: { name: "reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" },
			source: "project",
			path: "/workspace/.agents/subagents/reviewer.yml",
		})
		vi.spyOn(AgentConfigModule, "listEnabledAgentConfigs").mockResolvedValue([
			{
				config: { name: "reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" },
				source: "project",
				path: "/workspace/.agents/subagents/reviewer.yml",
			},
		])
		// Simulate the catalogue changing after Admission but before the run starts.
		callbacks.say.mockImplementation(async (type: string) => {
			if (type === "use_subagents") stubEnabledProfiles([])
			return undefined
		})
		const runSpy = vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "frozen plan completed",
			stats: {
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				currency: "USD",
				contextTokens: 0,
				contextWindow: 200000,
				contextUsagePercentage: 0,
			},
		})

		const handler = new UseSubagentsToolHandler()
		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([
					{ agent_name: "reviewer", task: "runs", context: "ctx runs", profile: "fast-reviewer" },
				]),
			},
			partial: false,
			ts: Date.now(),
		})

		assert.match(String(result), /frozen plan completed/)
		assert.equal(runSpy.mock.calls.length, 1, "execution must consume the plan that was prepared before approval")
	})

	it("lists default and bounded configured names for an unknown stable subagent", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		const handler = new UseSubagentToolHandler()
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue(undefined)
		vi.spyOn(AgentConfigModule, "listEnabledAgentConfigs").mockResolvedValue([
			{
				config: { name: "reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" },
				source: "project",
				path: "/workspace/.agents/subagents/reviewer.yml",
			},
		])

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENT,
			params: { agent_name: "missing", task: "review", context: "ctx" },
			partial: false,
			ts: Date.now(),
		})

		assert.match(String(result), /Unknown or disabled subagent 'missing'/)
		assert.match(String(result), /Available subagents: default, reviewer/)
	})

	it("runs stable use_subagent with selected YAML subagent", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		const createActivity = vi.fn()
		config.activityStore = {
			create: createActivity,
			update: vi.fn(),
			appendEvent: vi.fn(),
		} as unknown as TaskConfig["activityStore"]
		config.capabilityToggles.localSubagentsToggles = { "/workspace/.agents/subagents/code-reviewer.md": true }
		config.capabilityToggles.globalSubagentsToggles = { "/global/subagents/reviewer.yml": false }
		const handler = new UseSubagentToolHandler()
		const resolvedConfig = { name: "code-reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" }
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue({
			config: resolvedConfig,
			source: "project",
			path: "/workspace/.agents/subagents/code-reviewer.md",
		})

		const runStub = vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "stable done",
			stats: {
				toolCalls: 1,
				inputTokens: 2,
				outputTokens: 3,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.1,
				currency: "USD",
				contextTokens: 100,
				contextWindow: 200000,
				contextUsagePercentage: 0.05,
			},
		})

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENT,
			params: { agent_name: "code-reviewer", task: "review this PR", context: "check quality" },
			partial: false,
			ts: Date.now(),
		})

		assert.match(String(result), /stable done/)
		expect(runStub)
		assert.match(runStub.mock.calls[0][0], /<task>\s*review this PR\s*<\/task>/)
		assert.match(runStub.mock.calls[0][0], /<context>\s*check quality\s*<\/context>/)
		vitestExpect(AgentConfigModule.resolveAgentConfig).toHaveBeenCalledWith("/tmp", "code-reviewer", {
			subagentToggles: { "/workspace/.agents/subagents/code-reviewer.md": true },
			globalSubagentToggles: { "/global/subagents/reviewer.yml": false },
		})
		vitestExpect(createActivity).toHaveBeenCalledWith(
			vitestExpect.objectContaining({ executionMode: "foreground", cancellationOwner: "task" }),
		)
		assert.deepEqual(config.subagentJobManager?.listInjectableResults(), [])
	})

	it("hands a running foreground subagent to the background while retaining its task-scoped budget slot", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true, maxParallelSubagents: 1 })
		let activityInput: { continueInBackground?: () => Promise<boolean> } | undefined
		const createActivity = vi.fn((input: { continueInBackground?: () => Promise<boolean> }) => {
			activityInput = input
		})
		config.activityStore = {
			create: createActivity,
			update: vi.fn(),
			appendEvent: vi.fn(),
		} as unknown as TaskConfig["activityStore"]
		const handler = new UseSubagentToolHandler()
		const runResolvers: Array<(result: SubagentRunResult) => void> = []
		const runStub = vi.spyOn(SubagentRunner.prototype, "run").mockImplementation(
			() =>
				new Promise<SubagentRunResult>((resolve) => {
					runResolvers.push(resolve)
				}),
		)

		const execution = handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENT,
			params: { task: "review", context: "ctx" },
			partial: false,
			ts: Date.now(),
		})
		for (let attempt = 0; attempt < 10 && !activityInput; attempt += 1) await delay(0)

		assert.ok(activityInput?.continueInBackground, "foreground activity should expose a background handoff")
		assert.equal(await activityInput.continueInBackground(), true)
		const result = await execution
		assert.match(String(result), /Continued background subagent job: subagent_/)
		assert.match(String(result), /final result will be available only in a later model request/i)
		assert.equal(config.subagentFanoutBudget?.state().running, 1)

		const second = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENT,
			params: { task: "second review", context: "ctx", background: "true" },
			partial: false,
			ts: Date.now() + 1,
		})
		assert.match(String(second), /Started background subagent job: subagent_/)
		await delay(0)
		assert.equal(runStub.mock.calls.length, 1, "background handoff must not release the subagent budget slot")

		runResolvers[0]?.({
			status: "completed",
			result: "background completion",
			stats: {
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				currency: "USD",
				contextTokens: 0,
				contextWindow: 200000,
				contextUsagePercentage: 0,
			},
		})
		for (let attempt = 0; attempt < 10 && runStub.mock.calls.length < 2; attempt += 1) await delay(0)
		assert.equal(runStub.mock.calls.length, 2, "queued single subagent should start only after the handed-off runner ends")
		runResolvers[1]?.({
			status: "completed",
			result: "second completion",
			stats: {
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				currency: "USD",
				contextTokens: 0,
				contextWindow: 200000,
				contextUsagePercentage: 0,
			},
		})
		await delay(0)
	})

	it("hands a foreground batch to the background atomically without releasing its subagent slot", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true, maxParallelSubagents: 1 })
		const activityStore = new TaskActivityStore(config.taskId)
		config.activityStore = activityStore
		const runResolvers: Array<(result: SubagentRunResult) => void> = []
		vi.spyOn(SubagentRunner.prototype, "run").mockImplementation(
			() => new Promise<SubagentRunResult>((resolve) => runResolvers.push(resolve)),
		)
		const handler = new UseSubagentsToolHandler()
		const execution = handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([
					{ task: "first", context: "ctx-1" },
					{ task: "second", context: "ctx-2" },
				]),
			},
			partial: false,
			ts: Date.now(),
		})
		for (let attempt = 0; attempt < 20 && activityStore.list().length < 2; attempt += 1) await delay(0)
		assert.equal(runResolvers.length, 1, "the second batch item should queue behind the shared budget")
		const foregroundIds = activityStore.list().map((activity) => activity.activityId)
		assert.equal(foregroundIds.length, 2)
		// list() orders by creation time while the handoff reports the batch in
		// registration order; only the moved membership is the contract.
		const movedIds = await activityStore.moveToBackground([foregroundIds[0]])
		assert.deepEqual([...movedIds].sort(), [...foregroundIds].sort())
		const result = await execution
		assert.match(String(result), /Continued background subagent batch job: subagent_batch_/)
		assert.equal(config.subagentFanoutBudget?.state().running, 1)
		assert.equal(
			activityStore.list().filter((activity) => activity.executionMode === "background").length,
			2,
			"all batch activities must transfer ownership together",
		)

		const completed = (label: string): SubagentRunResult => ({
			status: "completed",
			result: label,
			stats: {
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				currency: "USD",
				contextTokens: 0,
				contextWindow: 200000,
				contextUsagePercentage: 0,
			},
		})
		runResolvers[0]?.(completed("first complete"))
		for (let attempt = 0; attempt < 20 && runResolvers.length < 2; attempt += 1) await delay(0)
		assert.equal(runResolvers.length, 2, "handoff must keep the first budget slot until its runner stops")
		runResolvers[1]?.(completed("second complete"))
		for (let attempt = 0; attempt < 20 && config.subagentFanoutBudget?.state().running !== 0; attempt += 1) await delay(0)
		assert.equal(config.subagentFanoutBudget?.state().running, 0)
	})

	it("registers soft Finish and exposes Retry only after a retryable background failure", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		let activityInput: { finish?: () => Promise<boolean> } | undefined
		const setRetry = vi.fn()
		const setCancel = vi.fn()
		const setFinish = vi.fn()
		config.activityStore = {
			create: vi.fn((input: { finish?: () => Promise<boolean> }) => {
				activityInput = input
			}),
			update: vi.fn(),
			appendEvent: vi.fn(),
			setRetry,
			setCancel,
			setFinish,
		} as unknown as TaskConfig["activityStore"]
		const handler = new UseSubagentToolHandler()
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue(undefined)
		const requestFinish = vi.spyOn(SubagentRunner.prototype, "requestFinish").mockResolvedValue(true)
		vi.spyOn(SubagentRunner.prototype, "run")
			.mockResolvedValueOnce({
				status: "failed",
				error: "temporary provider failure",
				retryable: true,
				stats: {
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					currency: "USD",
					contextTokens: 0,
					contextWindow: 200000,
					contextUsagePercentage: 0,
				},
			})
			.mockResolvedValueOnce({
				status: "completed",
				result: "recovered background result",
				stats: {
					toolCalls: 1,
					inputTokens: 5,
					outputTokens: 3,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					currency: "USD",
					contextTokens: 8,
					contextWindow: 200000,
					contextUsagePercentage: 0.004,
				},
			})

		const response = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENT,
			params: { task: "review", context: "ctx", background: "true" },
			partial: false,
			ts: Date.now(),
		})
		assert.match(String(response), /Started background subagent job/)
		assert.ok(activityInput?.finish, "running subagent activity should expose Finish")
		assert.equal(await activityInput.finish(), true)
		vitestExpect(requestFinish).toHaveBeenCalledWith("user")

		await vi.waitFor(() => {
			const retryRegistration = setRetry.mock.calls.find(([, retry]) => typeof retry === "function")
			assert.ok(retryRegistration, "retryable failure should register Retry")
		})
		const retry = setRetry.mock.calls.find(([, callback]) => typeof callback === "function")?.[1] as () => Promise<boolean>
		const jobId = config.subagentJobManager?.listJobs()[0]?.jobId
		assert.ok(jobId)
		assert.equal(await retry(), true)
		await vi.waitFor(() => assert.equal(config.subagentJobManager?.getJob(jobId)?.status, "completed"))
		assert.equal(config.subagentJobManager?.listInjectableResults().length, 1)
		vitestExpect(setCancel).toHaveBeenCalledWith(jobId, vitestExpect.any(Function))
		vitestExpect(setFinish).toHaveBeenCalledWith(jobId, vitestExpect.any(Function))
	})

	it("restores a persisted retry recipe after Task reopen", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		config.taskState.abort = true
		const activityStore = new TaskActivityStore("task-1")
		activityStore.create({
			activityId: "subagent-restored",
			kind: "subagent",
			executionMode: "background",
			title: "review",
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "default",
				task: "review",
				prompt: "<task>review</task><context>ctx</context>",
				timeoutSeconds: 30,
				retryable: true,
			},
		})
		activityStore.update("subagent-restored", { status: "failed", error: "temporary provider failure" })
		config.activityStore = activityStore
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue(undefined)
		vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "recovered after reopen",
			stats: emptyTestStats(),
		})

		assert.equal(await restoreSubagentActivityRetry(config, "subagent-restored"), true)
		assert.equal(activityStore.isRetryable("subagent-restored"), true)
		assert.deepEqual(await activityStore.retry(["subagent-restored"]), ["subagent-restored"])
		await vi.waitFor(() => assert.equal(activityStore.get("subagent-restored")?.status, "completed"))
		assert.equal(activityStore.get("subagent-restored")?.currentAttempt, 2)
		assert.equal(activityStore.get("subagent-restored")?.result, "recovered after reopen")
	})

	it("replays a restored retry with the Profile the batch item originally resolved", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		config.taskState.abort = true
		const activityStore = new TaskActivityStore("task-1")
		activityStore.create({
			activityId: "subagent-profile-bound",
			kind: "subagent",
			executionMode: "background",
			title: "reviewer",
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "reviewer",
				// The item overrode the subagent's own Profile when it first ran.
				profileName: "fast-reviewer",
				task: "review",
				prompt: "<task>review</task><context>ctx</context>",
				timeoutSeconds: 30,
				retryable: true,
			},
		})
		activityStore.update("subagent-profile-bound", { status: "failed", error: "temporary provider failure" })
		config.activityStore = activityStore
		// The subagent document now names a different Profile, so replaying from
		// the document alone would silently move the retry to another model.
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue({
			config: { name: "reviewer", profile: "slow-reviewer" },
			source: "project",
			path: "test-reviewer.md",
		} as unknown as ResolvedAgentConfig)
		// The recorded Profile still has to exist and still be enabled for
		// subagents, otherwise the retry is refused rather than quietly rerouted.
		stubEnabledProfiles(["fast-reviewer"])
		vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "recovered on the original Profile",
			stats: emptyTestStats(),
		})
		const builderCallsBefore = vitestMockedBuilder().mock.calls.length

		assert.equal(await restoreSubagentActivityRetry(config, "subagent-profile-bound"), true)

		const restoredConfig = vitestMockedBuilder().mock.calls.at(builderCallsBefore)?.[2]
		assert.equal(restoredConfig?.profile, "fast-reviewer", "the retry must run on the Profile the item originally resolved")
		assert.deepEqual(await activityStore.retry(["subagent-profile-bound"]), ["subagent-profile-bound"])
		await vi.waitFor(() => assert.equal(activityStore.get("subagent-profile-bound")?.status, "completed"))
	})

	it("leaves a restored retry on the subagent's current Profile when the item never overrode it", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		config.taskState.abort = true
		const activityStore = new TaskActivityStore("task-1")
		activityStore.create({
			activityId: "subagent-inherits-profile",
			kind: "subagent",
			executionMode: "background",
			title: "reviewer",
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "reviewer",
				// Recorded from the subagent document rather than an item override.
				profileName: "slow-reviewer",
				task: "review",
				prompt: "<task>review</task><context>ctx</context>",
				timeoutSeconds: 30,
				retryable: true,
			},
		})
		activityStore.update("subagent-inherits-profile", { status: "failed", error: "temporary provider failure" })
		config.activityStore = activityStore
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue({
			config: { name: "reviewer", profile: "slow-reviewer", model: "current" },
			source: "project",
			path: "test-reviewer.md",
		} as unknown as ResolvedAgentConfig)
		const builderCallsBefore = vitestMockedBuilder().mock.calls.length

		assert.equal(await restoreSubagentActivityRetry(config, "subagent-inherits-profile"), true)

		// The freshly resolved document is passed through untouched, so later
		// edits to the subagent still take effect on a retry.
		const restoredConfig = vitestMockedBuilder().mock.calls.at(builderCallsBefore)?.[2]
		assert.equal(restoredConfig?.profile, "slow-reviewer")
		assert.equal(restoredConfig?.model, "current", "an unchanged Profile must not replace the resolved document")
	})

	it("persists why a named subagent retry cannot be restored after Task reopen", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		const persisted: Array<ReturnType<TaskActivityStore["list"]>> = []
		const activityStore = new TaskActivityStore("task-1", {
			load: vi.fn(async () => persisted.at(-1) ?? []),
			save: vi.fn(async (activities: ReturnType<TaskActivityStore["list"]>) => {
				persisted.push(activities)
			}),
		})
		activityStore.create({
			activityId: "subagent-unavailable",
			kind: "subagent",
			executionMode: "background",
			title: "retired reviewer",
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "retired-reviewer",
				task: "review",
				prompt: "<task>review</task><context>ctx</context>",
				timeoutSeconds: 30,
				retryable: true,
			},
		})
		activityStore.update("subagent-unavailable", { status: "failed", error: "temporary provider failure" })
		config.activityStore = activityStore
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue(undefined)

		assert.equal(await restoreSubagentActivityRetry(config, "subagent-unavailable"), false)
		await activityStore.waitForPersistence()

		assert.equal(activityStore.isRetryable("subagent-unavailable"), false)
		assert.equal(activityStore.hasLiveRetryControl("subagent-unavailable"), false)
		vitestExpect(activityStore.get("subagent-unavailable")).toEqual(
			vitestExpect.objectContaining({
				retryUnavailableReason: "Retry unavailable: subagent 'retired-reviewer' is no longer enabled.",
				retryRecipe: vitestExpect.objectContaining({ retryable: false }),
			}),
		)
		vitestExpect(persisted.at(-1)?.[0]).toEqual(
			vitestExpect.objectContaining({
				retryUnavailableReason: "Retry unavailable: subagent 'retired-reviewer' is no longer enabled.",
				retryRecipe: vitestExpect.objectContaining({ retryable: false }),
			}),
		)
	})

	it("starts stable use_subagent background job", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		const createActivity = vi.fn()
		config.activityStore = {
			create: createActivity,
			update: vi.fn(),
			appendEvent: vi.fn(),
		} as unknown as TaskConfig["activityStore"]
		const handler = new UseSubagentToolHandler()
		const resolvedConfig = { name: "code-reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" }
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue({
			config: resolvedConfig,
			source: "project",
			path: "/workspace/.agents/subagents/code-reviewer.md",
		})
		vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "background done",
			stats: {
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				currency: "USD",
				contextTokens: 0,
				contextWindow: 200000,
				contextUsagePercentage: 0,
			},
		})

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENT,
			params: { agent_name: "code-reviewer", task: "review", context: "ctx", background: "true" },
			partial: false,
			ts: Date.now(),
		})

		assert.match(String(result), /Started background subagent job: subagent_/)
		assert.match(String(result), /final result will be available only in a later model request/i)
		assert.ok(config.subagentJobManager, "should attach a task-local subagent job manager")
		await delay(0)
		const subagentCalls = callbacks.say.mock.calls.filter((call) => call[0] === "subagent")
		assert.ok(subagentCalls.length >= 2, "should emit running and final background status")
		vitestExpect(createActivity).toHaveBeenCalledWith(
			vitestExpect.objectContaining({ executionMode: "background", cancellationOwner: "explicit" }),
		)
	})

	it("rejects a disabled batch before opening or replacing presentation", async () => {
		const { config, callbacks, taskState } = createConfig({ subagentsEnabled: false })
		const handler = new UseSubagentsToolHandler()
		const blockTs = Date.now()

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: { subagents: JSON.stringify([{ task: "do something", context: "ctx" }]) },
			partial: false,
			ts: blockTs,
		})

		assert.ok((result as string).includes("disabled"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
		assert.equal(
			callbacks.say.mock.calls.some((call) => call[0] === "use_subagents"),
			false,
			"invalid Admission must not open a handler-owned presentation",
		)
	})

	it("keeps fast background batch completion mapped to item entries", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		config.subagentJobManager = {
			startBatch: vi.fn((input) => {
				const batch = {
					batchJobId: "subagent_batch_1",
					status: "completed" as const,
					startedAt: Date.now(),
					finishedAt: Date.now(),
					timeoutSeconds: input.timeoutSeconds,
					itemJobIds: ["subagent_1"],
					injectionState: "pending" as const,
				}
				input.onCreated?.(batch)
				void input.onStatusChange?.(
					{
						jobId: "subagent_1",
						batchJobId: "subagent_batch_1",
						task: "fast",
						prompt: "<task>fast</task><context>ctx</context>",
						status: "completed" as const,
						startedAt: Date.now(),
						finishedAt: Date.now(),
						timeoutSeconds: input.timeoutSeconds,
						result: "fast done",
						injectionState: "pending" as const,
					},
					batch,
				)
				return batch
			}),
		} as unknown as TaskConfig["subagentJobManager"]
		const handler = new UseSubagentsToolHandler()

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: { subagents: JSON.stringify([{ task: "fast", context: "ctx" }]), background: "true" },
			partial: false,
			ts: Date.now(),
		})

		assert.match(String(result), /Started background subagent batch job: subagent_batch_1/)
		assert.match(String(result), /final result will be available only in a later model request/i)
		const subagentCalls = callbacks.say.mock.calls.filter((call) => call[0] === "subagent")
		const completedPayload = subagentCalls
			.map((call) => JSON.parse(call[1]))
			.find((payload) => payload.status === "completed")
		assert.equal(completedPayload.items[0].jobId, "subagent_1")
		assert.equal(completedPayload.items[0].status, "completed")
		assert.equal(completedPayload.items[0].result, "fast done")
	})

	it("allows exactly max prompts without error", async () => {
		const { config, taskState } = createConfig({ autoApproveSafe: true })
		const handler = new UseSubagentsToolHandler()
		vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "done",
			stats: {
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				currency: "USD",
				contextTokens: 0,
				contextWindow: 200000,
				contextUsagePercentage: 0,
			},
		})
		const blockTs = Date.now()

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify(
					Array.from({ length: MAX_SUBAGENTS_PER_BATCH }, (_unused, index) => ({
						task: `${index + 1}`,
						context: `ctx ${index + 1}`,
					})),
				),
			},
			partial: false,
			ts: blockTs,
		})

		assert.equal(taskState.consecutiveMistakeCount, 0)
		assert.ok(String(result).includes("Subagent results"), "should proceed normally with exactly max prompts")
	})

	it("reports the requested batch width even when every item is refused", async () => {
		// The metric answers how wide the model asked to fan out. Sampling only
		// started items would silently drop the batches that were refused,
		// which are exactly the ones worth seeing.
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		// The suite-wide setup already replaces the telemetry singleton, so the
		// recorded calls are read directly rather than layering a second spy.
		const fanout = vi.mocked(telemetryService.captureSubagentFanout)
		fanout.mockClear()
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue(undefined)
		vi.spyOn(AgentConfigModule, "listEnabledAgentConfigs").mockResolvedValue([])

		const handler = new UseSubagentsToolHandler()
		await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([
					{ agent_name: "missing-one", task: "never runs", context: "ctx one" },
					{ agent_name: "missing-two", task: "never runs", context: "ctx two" },
				]),
			},
			partial: false,
			ts: Date.now(),
		})

		assert.deepEqual(fanout.mock.calls, [[2, 0]], "a fully refused batch still reports the width it requested")
	})

	it("counts only the items that named a Profile through the tool parameter", async () => {
		// An inherited Profile is the default, so counting it would make the
		// figure report batch size a second time instead of answering whether
		// the per-item parameter is used.
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		const fanout = vi.mocked(telemetryService.captureSubagentFanout)
		fanout.mockClear()
		stubEnabledProfiles(["fast-reviewer"])
		vi.spyOn(AgentConfigModule, "resolveAgentConfig").mockResolvedValue({
			config: { name: "reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" },
			source: "project",
			path: "/workspace/.agents/subagents/reviewer.yml",
		})
		vi.spyOn(AgentConfigModule, "listEnabledAgentConfigs").mockResolvedValue([
			{
				config: { name: "reviewer", description: "reviewer", tools: [], systemPrompt: "Prompt" },
				source: "project",
				path: "/workspace/.agents/subagents/reviewer.yml",
			},
		])
		vi.spyOn(SubagentRunner.prototype, "run").mockResolvedValue({
			status: "completed",
			result: "done",
			stats: {
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				currency: "USD",
				contextTokens: 0,
				contextWindow: 200000,
				contextUsagePercentage: 0,
			},
		})

		const handler = new UseSubagentsToolHandler()
		await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.USE_SUBAGENTS,
			params: {
				subagents: JSON.stringify([
					{ agent_name: "reviewer", task: "bound", context: "ctx bound", profile: "fast-reviewer" },
					{ agent_name: "reviewer", task: "inherits", context: "ctx inherits" },
				]),
			},
			partial: false,
			ts: Date.now(),
		})

		assert.deepEqual(fanout.mock.calls, [[2, 1]])
	})
})
