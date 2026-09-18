import type { ToolUse } from "@core/assistant-message"
import type { ResolvedPromptRuntime } from "@core/prompts/system-prompt-cache/FrozenPromptRuntime"
import type { ToolAdmissionSnapshot } from "@core/task/executors/tool/ToolAdmissionRegistry"
import type { ToolPreflightResult, ToolSideEffect } from "@core/task/executors/tool/ToolPreflight"
import { ToolExecutor } from "@core/task/ToolExecutor"
import { SubagentFanoutBudget } from "@core/task/tools/subagent/SubagentFanoutBudget"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import type { BrowserSettings } from "@shared/BrowserSettings"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { HOSTED_WEB_SEARCH_ROUTING_PLAN } from "../../prompts/__tests__/web-search-routing-fixtures"

function buildRuntime(): ResolvedPromptRuntime {
	return {
		parallelToolsEnabled: true,
		webToolsEnabled: true,
		webSearchLocalFallbackAvailable: true,
		webSearchRoutingPlan: HOSTED_WEB_SEARCH_ROUTING_PLAN,
		focusChainEnabled: true,
		subagentsEnabled: true,
		capabilityToggles: createTaskCapabilityToggles({ mcpServers: { frozen: true } }),
		browserEnabled: true,
		browserViewport: { width: 1280, height: 800 },
	}
}

function buildExecutor(): ToolExecutor {
	const noop = vi.fn(async () => undefined)
	const liveBrowserSettings: BrowserSettings = {
		viewport: { width: 320, height: 200 },
		disableToolUse: true,
		remoteBrowserHost: "http://live.example",
	}
	return Object.assign(Object.create(ToolExecutor.prototype), {
		taskId: "task-runtime",
		ulid: "ulid-runtime",
		cwd: "E:/workspace/vscode/dline",
		getMode: () => "act",
		vscodeTerminalExecutionMode: "backgroundExec",
		stateManager: {
			getGlobalSettingsKey: (key: string) => {
				if (key === "clineWebToolsEnabled" || key === "enableParallelToolCalling") return false
				if (key === "focusChainSettings") return { enabled: false }
				if (key === "browserSettings") return liveBrowserSettings
				if (key === "autoApprovalSettings") return {}
				if (key === "strictPlanModeEnabled" || key === "yoloModeToggled" || key === "doubleCheckCompletionEnabled") {
					return false
				}
				return undefined
			},
			getApiConfiguration: () => ({ actModeProfile: "test-provider", planModeProfile: "test-provider" }),
		},
		taskState: {},
		taskController: {},
		messageStateHandler: {},
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		autoApprover: {},
		interactions: {},
		coordinator: {},
		subagentFanoutBudget: new SubagentFanoutBudget({ limit: 1 }),
		preparedEffects: new Map(),
		getTaskCapabilityToggles: () => createTaskCapabilityToggles({ mcpServers: { live: false } }),
		identityFactory: {},
		activityStore: {},
		focusChainForceUpdate: noop,
		say: noop,
		ask: noop,
		saveCheckpoint: noop,
		cancelTask: noop,
		executeCommandTool: noop,
		killCommandTool: noop,
		cancelRunningCommandTool: noop,
		doesLatestTaskCompletionHaveNewChanges: noop,
		updateFCListFromToolResponse: noop,
		sayAndCreateMissingParamError: noop,
		switchToActMode: noop,
		setActiveHookExecution: noop,
		clearActiveHookExecution: noop,
		getActiveHookExecution: noop,
		runUserPromptSubmitHook: noop,
		updateClineMessage: noop,
		mcpHub: {},
		browserSession: { dispose: noop },
		urlContentFetcher: {},
		diffViewProvider: {},
		fileContextTracker: {},
		taskFileTracker: {},
		ignoreController: {},
		commandPermissionController: {},
		contextManager: {},
		hostedServerToolMessageTs: new Map(),
	}) as ToolExecutor
}

describe("ToolExecutor frozen prompt runtime", () => {
	it("projects frozen gates and toggles into every handler config", () => {
		const executor = buildExecutor()
		executor.setPromptRuntime(buildRuntime())

		const config = (
			ToolExecutor.prototype as unknown as {
				asToolConfig(): TaskConfig
			}
		).asToolConfig.call(executor)

		expect(config.enableParallelToolCalling).toBe(true)
		expect(config.webToolsEnabled).toBe(true)
		expect(config.webSearchRoutingPlan).toMatchObject({ route: "hosted", serverTools: [ServerTool.WEB_SEARCH] })
		expect(config.focusChainSettings.enabled).toBe(true)
		expect(config.subagentsEnabled).toBe(true)
		expect(config.capabilityToggles.mcpServers).toEqual({ frozen: true })
		expect(config.browserSettings).toMatchObject({ disableToolUse: false, viewport: { width: 1280, height: 800 } })
	})

	it("injects one task-scoped subagent budget into every newly built handler config", () => {
		const executor = buildExecutor()
		const asToolConfig = (ToolExecutor.prototype as unknown as { asToolConfig(): TaskConfig }).asToolConfig

		const first = asToolConfig.call(executor)
		const second = asToolConfig.call(executor)

		expect(first).not.toBe(second)
		expect(first.subagentFanoutBudget).toBe(second.subagentFanoutBudget)
	})

	it("executes the exact unstarted closure retained by Admission once", async () => {
		const executor = buildExecutor()
		const internals = executor as unknown as {
			coordinator: {
				prepareAdmission: (
					block: ToolUse,
					snapshot: ToolAdmissionSnapshot,
					run: ToolSideEffect<void>,
				) => ToolPreflightResult<void>
			}
		}
		const executeTool = vi.spyOn(executor, "executeTool").mockImplementation(async () => undefined)
		internals.coordinator = {
			prepareAdmission: (_block: ToolUse, _snapshot: ToolAdmissionSnapshot, run: ToolSideEffect<void>) => ({
				outcome: "admitted",
				decision: { kind: "automatic", scope: "read_workspace", ceiling: "auto" },
				lanes: [],
				run,
			}),
		}
		const block: ToolUse = {
			type: "tool_use" as const,
			name: ClineDefaultTool.FILE_READ,
			params: { path: "src/a.ts" },
			partial: false,
			function_id: "function-prepared",
			dline_tid: "dline-prepared",
			ts: 1,
		}

		const admission = executor.prepareAdmission(block)
		expect(admission.outcome).toBe("admitted")
		expect(executeTool).not.toHaveBeenCalled()
		await executor.runPreparedAdmission(block.dline_tid)
		expect(executeTool).toHaveBeenCalledOnce()
		await expect(executor.runPreparedAdmission(block.dline_tid)).rejects.toThrow("Prepared tool effect is missing")
	})

	it("clears a previous complete runtime when a legacy Web-only request is configured", () => {
		const executor = buildExecutor()
		executor.setPromptRuntime(buildRuntime())
		executor.setWebSearchRoutingPlan({ ...HOSTED_WEB_SEARCH_ROUTING_PLAN, route: "disabled", serverTools: [] }, false)

		const config = (
			ToolExecutor.prototype as unknown as {
				asToolConfig(): TaskConfig
			}
		).asToolConfig.call(executor)

		expect(config.enableParallelToolCalling).toBe(false)
		expect(config.webToolsEnabled).toBe(false)
		expect(config.focusChainSettings.enabled).toBe(false)
		expect(config.subagentsEnabled).toBeUndefined()
		expect(config.capabilityToggles.mcpServers).toEqual({ live: false })
		expect(config.browserSettings).toMatchObject({ disableToolUse: true, viewport: { width: 320, height: 200 } })
	})

	it("rebuilds the browser session from the frozen viewport instead of live browser settings", async () => {
		const executor = buildExecutor()
		executor.setPromptRuntime(buildRuntime())

		const session = await executor.applyLatestBrowserSettings()
		const settings = (
			session as unknown as {
				getBrowserSettings(): BrowserSettings
			}
		).getBrowserSettings()

		expect(settings).toMatchObject({ disableToolUse: false, viewport: { width: 1280, height: 800 } })
	})
})
