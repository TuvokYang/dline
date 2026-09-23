import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/config", () => ({
	ClineEndpoint: {
		isSelfHosted: () => false,
		init: () => {},
		config: {
			environment: "production",
			appBaseUrl: "https://app.dline.bot",
			apiBaseUrl: "https://api.dline.bot",
			mcpBaseUrl: "https://mcp.cline.bot",
		},
	},
	ClineEnv: {
		config: () => ({}),
		setEnvironment: () => {},
		getEnvironment: () => "production",
	},
	ClineConfigurationError: class extends Error {
		constructor(m: string) {
			super(m)
			this.name = "ClineConfigurationError"
		}
	},
	Environment: { production: "production" },
}))

import * as coreApi from "@core/api"
import * as skills from "@core/context/instructions/user-instructions/skills"
import * as profileStore from "@core/controller/file/getApiProfiles"
import { PromptProfile } from "@core/prompts/profiles/types"
import * as systemPromptFacade from "@core/prompts/system-prompt"
import type { SystemPromptContext } from "@core/prompts/system-prompt/context"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { HostProvider } from "@/hosts/host-provider"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { Logger } from "@/shared/services/Logger"
import { createTaskCapabilityToggles } from "@/shared/TaskCapabilityToggles"
import { ClineDefaultTool } from "@/shared/tools"
import { TaskState } from "../../../TaskState"
import { GenerateImageToolHandler } from "../../handlers/GenerateImageToolHandler"
import { ListCodeDefinitionNamesToolHandler } from "../../handlers/ListCodeDefinitionNamesToolHandler"
import { ListFilesToolHandler } from "../../handlers/ListFilesToolHandler"
import { ReadFileToolHandler } from "../../handlers/ReadFileToolHandler"
import { SubagentBuilder } from "../SubagentBuilder"
import { SubagentRunner } from "../SubagentRunner"

function initializeHostProvider() {
	HostProvider.reset()
	HostProvider.initialize(
		() => ({}) as never,
		() => ({}) as never,
		() => ({}) as never,
		() => ({}) as never,
		{
			workspaceClient: {},
			envClient: { getHostVersion: async () => ({ platform: "test" }) },
			windowClient: {},
			diffClient: {},
		} as never,
		() => undefined,
		async () => "",
		async () => "",
		"",
		"",
	)
}

function createRemoteSkillEntry(
	name: string,
	description: string,
	options: { alwaysEnabled?: boolean } = {},
): GlobalInstructionsFile {
	return {
		name,
		alwaysEnabled: options.alwaysEnabled ?? false,
		contents: `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.`,
	}
}

type TestContentBlock = {
	type: string
	text?: string
	function_id?: string
	dline_tid?: string
	[key: string]: unknown
}

type TestConversationMessage = { role: string; content: TestContentBlock[] }
type SubagentRunnerTestAccess = { shouldCompactBeforeNextRequest: (...args: unknown[]) => boolean }

type TaskConfigOptions = {
	clineWebToolsEnabled?: boolean
	globalSkillsToggles?: Record<string, boolean>
	useAutoCondense?: boolean
	autoCondenseTriggerPercent?: number
	autoCondenseMinReserveTokens?: number
	autoCondenseMaxReserveTokens?: number
	autoCondenseMaxContextTokens?: number
	webToolsEnabled?: boolean
	providerRequestRounds?: TaskConfig["providerRequestRounds"]
	contextWindow?: number
	remoteSkillsToggles?: Record<string, boolean>
	localSkillsToggles?: Record<string, boolean>
	remoteGlobalSkills?: GlobalInstructionsFile[]
	taskGlobalSkillsToggles?: Record<string, boolean>
	taskLocalSkillsToggles?: Record<string, boolean>
	taskRemoteSkillsToggles?: Record<string, boolean>
}

function createTaskConfig(nativeToolCallEnabled: boolean, options: TaskConfigOptions = {}): TaskConfig {
	const globalSettings: Record<string, unknown> = {
		mode: "act",
		clineWebToolsEnabled: options.clineWebToolsEnabled,
		globalSkillsToggles: options.globalSkillsToggles,
		useAutoCondense: options.useAutoCondense,
		autoCondenseTriggerPercent: options.autoCondenseTriggerPercent,
		autoCondenseMinReserveTokens: options.autoCondenseMinReserveTokens,
		autoCondenseMaxReserveTokens: options.autoCondenseMaxReserveTokens,
		autoCondenseMaxContextTokens: options.autoCondenseMaxContextTokens,
	}
	const apiConfiguration = {
		actModeProfile: "anthropic",
		planModeProfile: "anthropic",
	}
	return {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: "/tmp",
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		doubleCheckCompletionEnabled: false,
		vscodeTerminalExecutionMode: "backgroundExec",
		enableParallelToolCalling: false,
		isSubagentExecution: false,
		webToolsEnabled: options.webToolsEnabled,
		providerRequestRounds: options.providerRequestRounds,
		context: {},
		taskState: new TaskState(),
		messageState: {},
		api: {
			getModel: () => ({
				id: "anthropic/claude-sonnet-4.5",
				info: {
					contextWindow: options.contextWindow ?? 200_000,
					apiFormats: [ApiFormat.ANTHROPIC_CHAT],
					supportsPromptCache: true,
					capabilities: {
						contextWindow: options.contextWindow ?? 200_000,
						supportsImages: false,
						supportsPromptCache: true,
					},
				},
			}),
			createMessage: vi.fn().mockImplementation(async function* () {}),
		},
		services: {
			stateManager: {
				getGlobalSettingsKey: (key: string) => globalSettings[key],
				getGlobalStateKey: (key: string) =>
					key === "nativeToolCallEnabled"
						? nativeToolCallEnabled
						: key === "remoteSkillsToggles"
							? options.remoteSkillsToggles
							: undefined,
				getWorkspaceStateKey: (key: string) => (key === "localSkillsToggles" ? options.localSkillsToggles : undefined),
				getRemoteConfigSettings: () => ({
					remoteGlobalSkills: options.remoteGlobalSkills ?? [],
				}),
				getApiConfiguration: () => apiConfiguration,
				getApiConfigurationForTask: (taskId?: string) => {
					assert.equal(taskId, "task-1")
					return apiConfiguration
				},
			},
			imageGenerationService: {
				hasAvailableProfile: vi.fn(() => false),
				withProfileResolver: vi.fn(() => ({ hasAvailableProfile: vi.fn(() => false) })),
			},
		},
		browserSettings: {},
		focusChainSettings: {},
		capabilityToggles: createTaskCapabilityToggles({
			globalSkillsToggles: options.taskGlobalSkillsToggles ?? options.globalSkillsToggles,
			localSkillsToggles: options.taskLocalSkillsToggles ?? options.localSkillsToggles,
			remoteSkillsToggles: options.taskRemoteSkillsToggles ?? options.remoteSkillsToggles,
		}),
		autoApprovalSettings: {
			enableNotifications: false,
			actions: { executeSafeCommands: false, executeAllCommands: false },
		},
		autoApprover: {
			shouldAutoApproveTool: vi.fn().mockReturnValue([false, false]),
		},
		callbacks: {
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			saveCheckpoint: vi.fn().mockResolvedValue(undefined),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
			removeLastPartialMessageIfExistsWithType: vi.fn().mockResolvedValue(undefined),
			executeCommandTool: vi
				.fn()
				.mockResolvedValue({ userRejected: false, result: "ok", completed: true, exitCode: 0, signal: null }),
			cancelRunningCommandTool: vi.fn().mockResolvedValue(false),
			doesLatestTaskCompletionHaveNewChanges: vi.fn().mockResolvedValue(false),
			updateFCListFromToolResponse: vi.fn().mockResolvedValue(undefined),
			shouldAutoApproveTool: vi.fn().mockReturnValue([true, true]),
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
		},
		coordinator: {
			getHandler: vi.fn().mockImplementation((toolName: ClineDefaultTool) => {
				if (toolName === ClineDefaultTool.LIST_FILES)
					return {
						execute: vi.fn().mockResolvedValue("ok"),
						getDescription: vi.fn().mockReturnValue("list_files"),
					}
				return undefined
			}),
		},
	} as unknown as TaskConfig
}

/** Stubs the stable profile facade used by subagent tests. */
function stubSystemPrompt(native: boolean, inspectContext?: (context: SystemPromptContext) => void): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(systemPromptFacade, "getSystemPrompt").mockImplementation(async (context) => {
		inspectContext?.(context)
		return {
			systemPrompt: "system prompt",
			tools: native
				? [
						{
							type: "function",
							function: { name: ClineDefaultTool.LIST_FILES, description: "List files" },
						},
					]
				: undefined,
			profile: PromptProfile.Standard,
			warnings: [],
		}
	})
}

function stubApiHandler(
	createMessage: ReturnType<typeof vi.fn>,
	contextWindow = 200_000,
	hostedWebSearch = false,
	abort = vi.fn(),
) {
	vi.spyOn(coreApi, "buildApiHandler").mockReturnValue({
		abort,
		getProviderId: () => "anthropic",
		supportsServerTool: (tool: ServerTool) => hostedWebSearch && tool === ServerTool.WEB_SEARCH,
		getModel: () => ({
			id: "anthropic/claude-sonnet-4.5",
			info: {
				contextWindow,
				apiFormats: [ApiFormat.ANTHROPIC_CHAT],
				supportsPromptCache: true,
				capabilities: {
					contextWindow,
					supportsImages: false,
					supportsPromptCache: true,
					supportsTools: true,
					tools: hostedWebSearch ? [ServerTool.WEB_SEARCH] : [],
				},
			},
		}),
		createMessage,
	} as never)
}

/** Stubs a handler whose model declares and whose adapter carries the given hosted tools. */
function stubHostedToolsApiHandler(createMessage: ReturnType<typeof vi.fn>, tools: readonly ServerTool[]) {
	vi.spyOn(coreApi, "buildApiHandler").mockReturnValue({
		abort: vi.fn(),
		getProviderId: () => "anthropic",
		supportsServerTool: (tool: ServerTool) => tools.includes(tool),
		getModel: () => ({
			id: "anthropic/claude-sonnet-4.5",
			info: {
				contextWindow: 200_000,
				apiFormats: [ApiFormat.ANTHROPIC_CHAT],
				supportsPromptCache: true,
				capabilities: {
					contextWindow: 200_000,
					supportsImages: false,
					supportsPromptCache: true,
					supportsTools: true,
					tools: [...tools],
				},
			},
		}),
		createMessage,
	} as never)
}

function createContextApi(contextWindow: number): ReturnType<typeof coreApi.buildApiHandler> {
	return {
		getModel: () => ({
			id: "gpt-5.4-mini",
			info: {
				capabilities: {
					contextWindow,
					supportsImages: false,
					supportsPromptCache: true,
				},
			},
		}),
	} as unknown as ReturnType<typeof coreApi.buildApiHandler>
}

describe("SubagentRunner", () => {
	beforeEach(() => {
		vi.spyOn(ListFilesToolHandler.prototype, "execute").mockResolvedValue("ok")
	})

	afterEach(() => {
		HostProvider.reset()
		vi.restoreAllMocks()
	})

	it("binds image prompt and tool execution to the subagent Profile while reusing the parent service boundary", async () => {
		vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([
			{
				id: "subagent-profile-id",
				name: "subagent-images",
				provider: "openai",
				modelId: "custom-responses-model",
				imageModelId: "gpt-image-2",
				usedFor: ["subagents"],
				enabled: true,
			},
		] as ReturnType<typeof profileStore.readApiProfiles>)
		let requestRound = 0
		const createMessage = vi.fn().mockImplementation(async function* () {
			requestRound += 1
			yield {
				type: "tool_calls",
				function_id: requestRound === 1 ? "generate-image" : "complete",
				tool_call: {
					function: {
						name: requestRound === 1 ? ClineDefaultTool.GENERATE_IMAGE : ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify(requestRound === 1 ? { prompt: "Draw a fox" } : { result: "done" }),
					},
				},
			}
		})
		let promptContext: SystemPromptContext | undefined
		stubSystemPrompt(false, (context) => {
			promptContext ??= context
		})
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		// The explicit subagent Profile resolves, so the builder takes the
		// Profile-bound handler path; without this double the mock Profile has no
		// credentials and the run fails while constructing a real provider client.
		vi.spyOn(coreApi, "buildApiHandlerFromProfile").mockImplementation(() => coreApi.buildApiHandler({} as never, "act"))
		initializeHostProvider()
		const config = createTaskConfig(false)
		const derivedImageService = { hasAvailableProfile: vi.fn(() => true) }
		const withProfileResolver = vi.fn(() => derivedImageService)
		config.services.imageGenerationService.withProfileResolver = withProfileResolver as never
		const executeGenerateImage = vi
			.spyOn(GenerateImageToolHandler.prototype, "execute")
			.mockImplementation(async (toolConfig) => {
				expect(toolConfig.services.imageGenerationService).toBe(derivedImageService)
				return "generated"
			})
		const runner = new SubagentRunner(config, "image-agent", {
			name: "image-agent",
			description: "image subagent",
			profile: "subagent-images",
			tools: [ClineDefaultTool.GENERATE_IMAGE],
			systemPrompt: "",
		})

		const result = await runner.run("Create an image", () => {})

		expect(result.status).toBe("completed")
		expect(withProfileResolver).toHaveBeenCalledOnce()
		expect(promptContext?.imageGenerationAvailable).toBe(true)
		expect(promptContext?.disableTools).not.toContain(ClineDefaultTool.GENERATE_IMAGE)
		expect(executeGenerateImage).toHaveBeenCalledOnce()
	})

	it("fails closed when inherited subagent approval hits a manual-only external scope", async () => {
		let requestRound = 0
		const createMessage = vi.fn().mockImplementation(async function* () {
			requestRound += 1
			yield {
				type: "tool_calls",
				function_id: requestRound === 1 ? "read-external" : "complete-after-denial",
				tool_call: {
					function: {
						name: requestRound === 1 ? ClineDefaultTool.FILE_READ : ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify(requestRound === 1 ? { path: "../outside.txt" } : { result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const executeRead = vi.spyOn(ReadFileToolHandler.prototype, "execute")
		const config = createTaskConfig(false)
		config.cwd = "/workspace"
		config.autoApprovalSettings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
				readFiles: true,
				readFilesExternally: true,
			},
			ceilings: { read_external: "manual_only" },
		}
		const runner = new SubagentRunner(config, "policy-agent", {
			name: "policy-agent",
			description: "Exercises inherited tool admission.",
			tools: [ClineDefaultTool.FILE_READ, ClineDefaultTool.ATTEMPT],
			systemPrompt: "",
		})

		const result = await runner.run("Read outside the workspace", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, "done")
		expect(executeRead).not.toHaveBeenCalled()
	})

	it.each([
		[63_999, PromptProfile.Lite],
		[64_000, PromptProfile.Standard],
	] as const)("resolves context window %s to %s before building the subagent prompt", async (contextWindow, expected) => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "profile-complete",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false, (context) => {
			assert.equal(context.promptProfile, expected)
		})
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage, contextWindow)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false, { contextWindow })).run("Use profile", () => {})

		assert.equal(result.status, "completed", result.error)
	})

	it("reports cancellation before the first API request as cancelled", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const config = createTaskConfig(false)
		config.taskState.abort = true
		const progress = vi.fn()

		const result = await new SubagentRunner(config).run("Cancel before request", progress)

		assert.equal(result.status, "cancelled")
		assert.equal(result.error, "Subagent run cancelled.")
		assert.equal(createMessage.mock.calls.length, 0)
		assert.equal(progress.mock.calls.at(-1)?.[0].status, "cancelled")
	})

	// A retry reuses the same runner instance. Before the guard, the second run
	// reset `abortRequested` and replaced the abort controllers while the first
	// one was still unwinding, so the two runs cancelled each other's requests.
	it("serializes a retry against a run that has not unwound yet", async () => {
		const runOrder: string[] = []
		let releaseFirstRun: (() => void) | undefined
		const firstRunReachedProvider = new Promise<void>((resolve) => {
			releaseFirstRun = resolve
		})
		let call = 0
		const createMessage = vi.fn().mockImplementation(async function* () {
			call += 1
			const label = `run-${call}`
			runOrder.push(`${label}:start`)
			if (call === 1) {
				await firstRunReachedProvider
			}
			runOrder.push(`${label}:end`)
			yield {
				type: "tool_calls",
				function_id: `${label}-complete`,
				tool_call: { function: { name: ClineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: label }) } },
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(false))

		const first = runner.run("First run", () => {})
		await vi.waitFor(() => {
			assert.equal(runOrder.includes("run-1:start"), true)
		})
		const second = runner.run("Retry run", () => {})
		// The retry must not reach the provider while the first run is in flight.
		assert.equal(createMessage.mock.calls.length, 1)

		releaseFirstRun?.()
		const [firstResult, secondResult] = await Promise.all([first, second])

		assert.deepEqual(runOrder, ["run-1:start", "run-1:end", "run-2:start", "run-2:end"])
		assert.equal(firstResult.status, "completed", firstResult.error)
		assert.equal(firstResult.result, "run-1")
		assert.equal(secondResult.status, "completed", secondResult.error)
		assert.equal(secondResult.result, "run-2")
		assert.equal(createMessage.mock.calls.length, 2)
	})

	// A failed run must not block the next one: the guard waits for the previous
	// run to settle, not for it to succeed.
	it("starts the next run after the previous one rejects", async () => {
		// The first run must exhaust its own backoff sequence before it can fail,
		// so every attempt of that run has to reject.
		let firstRunFinished = false
		const createMessage = vi.fn().mockImplementation(async function* () {
			if (!firstRunFinished) throw new Error("first run exploded")
			yield {
				type: "tool_calls",
				function_id: "after-failure-complete",
				tool_call: { function: { name: ClineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "recovered" }) } },
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(false))

		const failed = await runner.run("Failing run", () => {})
		assert.equal(failed.status, "failed")
		firstRunFinished = true

		const recovered = await runner.run("Recovered run", () => {})
		assert.equal(recovered.status, "completed", recovered.error)
		assert.equal(recovered.result, "recovered")
	})

	it("allows an explicitly restored Activity runner to outlive an inert parent Task", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "restored-activity-complete",
				tool_call: { function: { name: ClineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "restored" }) } },
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const config = createTaskConfig(false)
		config.taskState.abort = true

		const result = await new SubagentRunner(config, "subagent", undefined, { inheritTaskAbort: false }).run(
			"Resume explicit Activity",
			() => {},
		)

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, "restored")
		assert.equal(createMessage.mock.calls.length, 1)
	})

	it("does not give the default subagent hosted Web Search outside its tool allowlist", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "complete-without-search",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage, 200_000, true)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false, { clineWebToolsEnabled: true })).run(
			"Do not search remotely",
			() => {},
		)

		assert.equal(result.status, "completed", result.error)
		assert.deepEqual(createMessage.mock.calls[0][3], { serverTools: [], retryOwner: "subagent" })
	})

	it("uses the request-frozen Web Tools switch when the live setting changes", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "complete-with-frozen-search",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage, 200_000, true)
		initializeHostProvider()
		const config = createTaskConfig(false, { clineWebToolsEnabled: false, webToolsEnabled: true })

		const result = await new SubagentRunner(config, "web-researcher", {
			name: "web-researcher",
			description: "Researches current information on the web.",
			tools: [ClineDefaultTool.WEB_SEARCH, ClineDefaultTool.ATTEMPT],
			systemPrompt: "",
		}).run("Use the frozen request gate", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.deepEqual(createMessage.mock.calls[0][3], {
			serverTools: [ServerTool.WEB_SEARCH],
			retryOwner: "subagent",
		})
	})

	it("reports hosted Web Search lifecycle when the subagent allowlist explicitly enables it", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "server_tool",
				function_id: "srv-search-1",
				tool: ServerTool.WEB_SEARCH,
				phase: "started",
				input: { query: "latest Dline docs" },
			}
			yield {
				type: "server_tool",
				function_id: "srv-search-1",
				tool: ServerTool.WEB_SEARCH,
				phase: "completed",
				result: [{ title: "Dline docs" }],
			}
			yield {
				type: "tool_calls",
				function_id: "complete-after-search",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage, 200_000, true)
		initializeHostProvider()
		const config = createTaskConfig(false, { clineWebToolsEnabled: true })
		const progress = vi.fn()

		const result = await new SubagentRunner(config, "web-researcher", {
			name: "web-researcher",
			description: "Researches current information on the web.",
			tools: [ClineDefaultTool.WEB_SEARCH, ClineDefaultTool.ATTEMPT],
			systemPrompt: "",
		}).run("Search remotely", progress)

		assert.equal(result.status, "completed", result.error)
		assert.deepEqual(createMessage.mock.calls[0][3], {
			serverTools: [ServerTool.WEB_SEARCH],
			retryOwner: "subagent",
		})
		const hostedEvents = progress.mock.calls
			.map(([update]) => update.event)
			.filter((event) => event?.toolName === "web_search")
		assert.equal(hostedEvents.length, 2)
		assert.equal(hostedEvents[0].kind, "tool_call")
		assert.equal(hostedEvents[1].kind, "tool_result")
		assert.equal(hostedEvents[1].toolStatus, "completed")
		expect(config.coordinator.getHandler).not.toHaveBeenCalledWith(ClineDefaultTool.WEB_SEARCH)
	})

	it.each([
		{ allowed: [ClineDefaultTool.WEB_FETCH], serverTools: [ServerTool.WEB_FETCH] },
		{ allowed: [ClineDefaultTool.WEB_SEARCH], serverTools: [ServerTool.WEB_SEARCH] },
	])("declares only the hosted web tools in the allowlist $allowed", async ({ allowed, serverTools }) => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "complete-with-allowed-web-tools",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubHostedToolsApiHandler(createMessage, [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH])
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false, { clineWebToolsEnabled: true }), "web-researcher", {
			name: "web-researcher",
			description: "Researches current information on the web.",
			tools: [...allowed, ClineDefaultTool.ATTEMPT],
			systemPrompt: "",
		}).run("Use only the allowed web tool", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.deepEqual(createMessage.mock.calls[0][3], { serverTools, retryOwner: "subagent" })
	})

	it("withholds hosted web tools when the web ceiling reserves them for manual approval", async () => {
		// Hosted tools bypass tool admission, so the ceiling that fails a local web
		// tool closed inside a subagent must keep the hosted ones off the request.
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "complete-without-hosted-web",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubHostedToolsApiHandler(createMessage, [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH])
		initializeHostProvider()
		const config = createTaskConfig(false, { clineWebToolsEnabled: true })
		config.autoApprovalSettings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useWeb: true },
			ceilings: { web: "manual_only" },
		}

		const result = await new SubagentRunner(config, "web-researcher", {
			name: "web-researcher",
			description: "Researches current information on the web.",
			tools: [ClineDefaultTool.WEB_SEARCH, ClineDefaultTool.WEB_FETCH, ClineDefaultTool.ATTEMPT],
			systemPrompt: "",
		}).run("Do not use hosted web tools", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.deepEqual(createMessage.mock.calls[0][3], { serverTools: [], retryOwner: "subagent" })
	})

	it("reports cancellation between API turns as cancelled", async () => {
		const config = createTaskConfig(false)
		const createMessage = vi.fn().mockImplementation(async function* () {
			config.taskState.abort = true
			yield* []
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const progress = vi.fn()

		const result = await new SubagentRunner(config).run("Cancel between turns", progress)

		assert.equal(result.status, "cancelled")
		assert.equal(result.error, "Subagent run cancelled.")
		assert.equal(createMessage.mock.calls.length, 1)
		assert.equal(progress.mock.calls.at(-1)?.[0].status, "cancelled")
	})

	it("reports cancellation after a tool result as cancelled", async () => {
		const config = createTaskConfig(true)
		vi.mocked(ListFilesToolHandler.prototype.execute).mockImplementation(async () => {
			config.taskState.abort = true
			return "ok"
		})
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "toolu_cancel_after_result",
				tool_call: {
					function: {
						name: ClineDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		stubSystemPrompt(true)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const progress = vi.fn()

		const result = await new SubagentRunner(config).run("Cancel after tool", progress)

		assert.equal(result.status, "cancelled")
		assert.equal(result.error, "Subagent run cancelled.")
		assert.equal(createMessage.mock.calls.length, 1)
		assert.equal(progress.mock.calls.at(-1)?.[0].status, "cancelled")
	})

	it("builds subagent prompts through the stable system prompt facade", async () => {
		const createMessage = vi.fn().mockImplementation(async function* (systemPrompt: string) {
			assert.match(systemPrompt, /^facade system prompt/)
			yield {
				type: "tool_calls",
				function_id: "facade-complete",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		const facade = vi.spyOn(systemPromptFacade, "getSystemPrompt").mockImplementation(async (context) => {
			assert.equal(context.isSubagentRun, true)
			return {
				systemPrompt: "facade system prompt",
				tools: undefined,
				profile: PromptProfile.Standard,
				warnings: [],
			}
		})
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Use facade", () => {})

		assert.equal(facade.mock.calls.length, 2)
		const [ordinaryContext] = facade.mock.calls[0]
		const [completionContext] = facade.mock.calls[1]
		assert.equal(ordinaryContext.isSubagentRun, true)
		assert.equal(completionContext.isSubagentRun, true)
		assert.equal(completionContext.clineWebToolsEnabled, false)
		assert.equal(completionContext.disableTools?.includes(ClineDefaultTool.ATTEMPT), false)
		for (const tool of Object.values(ClineDefaultTool)) {
			if (tool !== ClineDefaultTool.ATTEMPT) assert.equal(completionContext.disableTools?.includes(tool), true)
		}
		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
	})

	it("keeps platform rules when appending the configured YAML instructions", async () => {
		const createMessage = vi.fn().mockImplementation(async function* (systemPrompt: string) {
			assert.match(systemPrompt, /^generated facade prompt/)
			assert.match(systemPrompt, /# Subagent Custom Instructions/)
			assert.match(systemPrompt, /Local YAML system prompt\./)
			assert.match(systemPrompt, /Plain assistant text cannot complete a subagent run/)
			yield {
				type: "tool_calls",
				function_id: "yaml-prompt-complete",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		vi.spyOn(systemPromptFacade, "getSystemPrompt").mockResolvedValue({
			systemPrompt: "generated facade prompt",
			tools: undefined,
			profile: PromptProfile.Standard,
			warnings: [],
		})
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false), "local-reviewer", {
			name: "local-reviewer",
			description: "Local reviewer",
			tools: [ClineDefaultTool.ATTEMPT],
			systemPrompt: "Local YAML system prompt.",
		}).run("Use local config", () => {})

		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.equal(createMessage.mock.calls.length, 1)
	})

	it("emits native tool blocks with matching canonical identities across turns", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_1",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
			const am = c[1] as TestConversationMessage
			assert.equal(am.role, "assistant")
			const tu = am.content.find((block) => block.type === "tool_use")
			assert.ok(tu)
			assert.equal(tu.function_id, "toolu_subagent_1")
			assert.ok(tu.dline_tid)
			assert.equal("id" in tu, false)
			assert.equal("call_id" in tu, false)
			const um = c[2] as TestConversationMessage
			assert.equal(um.role, "user")
			const tr = um.content.find((block) => block.type === "tool_result")
			assert.ok(tr)
			assert.equal(tr.function_id, tu.function_id)
			assert.equal(tr.dline_tid, tu.dline_tid)
			assert.equal("tool_use_id" in tr, false)
			assert.equal("call_id" in tr, false)
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_complete_1",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(true)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(true))
		const progress = vi.fn()
		const result = await runner.run("List files", progress)
		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, "done")
		assert.equal(createMessage.mock.calls.length, 2)
		const completedToolEvents = progress.mock.calls
			.map(([update]) => update.event)
			.filter((event) => event?.kind === "tool_call" && event.toolStatus === "completed")
		assert.deepEqual(
			completedToolEvents.map((event) => ({ toolName: event.toolName, summary: event.summary })),
			[
				{ toolName: ClineDefaultTool.LIST_FILES, summary: "list_files(path=., recursive=false)" },
				{ toolName: ClineDefaultTool.ATTEMPT, summary: "attempt_completion(result=done)" },
			],
		)
		assert.equal(new Set(completedToolEvents.map((event) => event.toolCallId)).size, 2)
		assert.ok(completedToolEvents.every((event) => event.toolCallId?.startsWith("dline_tid_")))
	})

	it("replays provider reasoning with its final signature before native tool use", async () => {
		const createMessage = vi.fn()
		let secondConversation: unknown[] = []
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "reasoning", reasoning: "Inspecting the workspace" }
			yield { type: "reasoning", reasoning: "", signature: "provider-signature" }
			yield {
				type: "tool_calls",
				function_id: "provider-read",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
			secondConversation = conversation
			yield {
				type: "tool_calls",
				function_id: "provider-complete",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(true)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(true)).run("Inspect files", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, "done")
		assert.equal(createMessage.mock.calls.length, 2)
		const assistant = secondConversation[1] as { content: Array<Record<string, unknown>>; role: string }
		assert.equal(assistant.role, "assistant")
		assert.deepEqual(assistant.content[0], {
			type: "thinking",
			thinking: "Inspecting the workspace",
			signature: "provider-signature",
			summary: [],
			provider_metadata: undefined,
		})
		assert.equal(assistant.content[1]?.type, "tool_use")
		assert.equal(assistant.content[1]?.function_id, "provider-read")
	})

	it("discards reasoning from a failed replayable attempt before retrying", async () => {
		const createMessage = vi.fn()
		let nextRoundConversation: unknown[] = []
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "reasoning",
				reasoning: "Failed attempt reasoning",
				provider_metadata: { response_id: "failed-reasoning" },
			}
			yield { type: "reasoning", reasoning: "", signature: "failed-signature" }
			throw Object.assign(new Error("stream_read_error"), {
				code: "stream_read_error",
				error: { code: "stream_read_error", message: "stream_read_error", type: "upstream_error" },
			})
		})
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "reasoning",
				reasoning: "Successful attempt reasoning",
				provider_metadata: { response_id: "successful-reasoning" },
			}
			yield { type: "reasoning", reasoning: "", signature: "successful-signature" }
			yield {
				type: "tool_calls",
				function_id: "provider-read-after-retry",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
			nextRoundConversation = conversation
			yield {
				type: "tool_calls",
				function_id: "provider-complete-after-retry",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(true)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(true)).run("Inspect files", () => {})

		assert.equal(result.status, "completed", result.error)
		const assistant = nextRoundConversation[1] as {
			content: Array<Record<string, unknown>>
			provider_metadata?: { response_id?: string }
		}
		assert.deepEqual(assistant.content[0], {
			type: "thinking",
			thinking: "Successful attempt reasoning",
			signature: "successful-signature",
			summary: [],
			provider_metadata: { response_id: "successful-reasoning" },
		})
		assert.equal(assistant.provider_metadata?.response_id, "successful-reasoning")
	})

	it("adds a text follower when a provider turn contains reasoning only", async () => {
		const createMessage = vi.fn()
		let nextRoundConversation: unknown[] = []
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "reasoning", reasoning: "Reasoning without a response", signature: "reasoning-only-signature" }
		})
		createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
			nextRoundConversation = conversation
			yield {
				type: "tool_calls",
				function_id: "provider-complete-after-reasoning-only",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(true)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(true)).run("Inspect files", () => {})

		assert.equal(result.status, "completed", result.error)
		const assistant = nextRoundConversation[1] as { content: Array<Record<string, unknown>> }
		assert.equal(assistant.content[0]?.type, "thinking")
		assert.deepEqual(assistant.content[1], {
			type: "text",
			text: "Failure: I did not provide a response.",
		})
	})

	it("records structured tool calls received while non-native mode is enabled", async () => {
		const createMessage = vi.fn()
		let nextRoundConversation: unknown[] = []
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "reasoning", reasoning: "Inspecting through a structured fallback" }
			yield {
				type: "tool_calls",
				function_id: "provider-structured-fallback-read",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
			nextRoundConversation = conversation
			yield {
				type: "tool_calls",
				function_id: "provider-structured-fallback-complete",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Inspect files", () => {})

		assert.equal(result.status, "completed", result.error)
		const assistant = nextRoundConversation[1] as {
			content: Array<Record<string, unknown>>
			provider_metadata?: { response_id?: string }
		}
		assert.equal(assistant.content[0]?.type, "thinking")
		assert.deepEqual(assistant.content[1], {
			type: "text",
			text: "Tool calls: list_files",
		})
		assert.equal(assistant.provider_metadata, undefined)
	})

	it("allocates unique identities for non-native tools across provider rounds", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "text",
				text: "<list_files>\n<path>.</path>\n<recursive>false</recursive>\n</list_files>",
			}
		})
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "text",
				text: "<list_files>\n<path>src</path>\n<recursive>false</recursive>\n</list_files>",
			}
		})
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "text",
				text: "<attempt_completion>\n<result>done</result>\n</attempt_completion>",
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const progress = vi.fn()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Inspect files", progress)

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, "done")
		const completedToolEvents = progress.mock.calls
			.map(([update]) => update.event)
			.filter((event) => event?.kind === "tool_call" && event.toolStatus === "completed")
		assert.equal(completedToolEvents.length, 3)
		assert.equal(new Set(completedToolEvents.map((event) => event.toolCallId)).size, 3)
	})

	it("stops the current attempt at attempt_completion before executing later tool calls", async () => {
		const executeListFiles = vi.mocked(ListFilesToolHandler.prototype.execute)
		executeListFiles.mockResolvedValue("must not run")
		const createMessage = vi.fn().mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "toolu_completion_boundary",
				tool_index: 0,
				tool_call: { function: { name: ClineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
			}
			yield {
				type: "tool_calls",
				function_id: "toolu_after_completion",
				tool_index: 1,
				tool_call: { function: { name: ClineDefaultTool.LIST_FILES, arguments: JSON.stringify({ path: "." }) } },
			}
		})
		stubSystemPrompt(true)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const config = createTaskConfig(true)
		const progress = vi.fn()

		const result = await new SubagentRunner(config).run("Complete before later tools", progress)

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, "done")
		assert.equal(result.stats.toolCalls, 1)
		assert.equal(executeListFiles.mock.calls.length, 0)
		const completedTools = progress.mock.calls
			.map(([update]) => update.event)
			.filter((event) => event?.kind === "tool_call" && event.toolStatus === "completed")
		assert.deepEqual(
			completedTools.map((event) => event.toolName),
			[ClineDefaultTool.ATTEMPT],
		)
	})

	it("switches a timeout finish request to an attempt_completion-only next turn", async () => {
		let runner: SubagentRunner
		const abort = vi.fn()
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			await runner.requestFinish("timeout")
			yield { type: "text", text: "partial findings" }
		})
		createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[], tools: unknown[]) {
			const reminder = conversation.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
			assert.equal(reminder.role, "user")
			assert.match(reminder.content[0]?.text || "", /time limit/i)
			assert.match(reminder.content[0]?.text || "", /Do not call any other tool/i)
			assert.deepEqual(
				(tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
				[ClineDefaultTool.ATTEMPT],
			)
			yield {
				type: "tool_calls",
				function_id: "toolu_timeout_complete",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "finished after timeout reminder" }),
					},
				},
			}
		})
		vi.spyOn(systemPromptFacade, "getSystemPrompt").mockResolvedValue({
			systemPrompt: "system prompt",
			tools: [
				{ type: "function", function: { name: ClineDefaultTool.LIST_FILES, description: "List files" } },
				{ type: "function", function: { name: ClineDefaultTool.ATTEMPT, description: "Complete" } },
			] as never,
			profile: PromptProfile.Standard,
			warnings: [],
		})
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage, 200_000, false, abort)
		initializeHostProvider()
		runner = new SubagentRunner(createTaskConfig(true))

		const result = await runner.run("Explore until timeout", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, "finished after timeout reminder")
		assert.equal(createMessage.mock.calls.length, 2)
		assert.equal(abort.mock.calls.length, 1)
	})

	it("reports the effective runtime configuration before the first provider request", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "runtime-config-complete",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const progress = vi.fn()

		const result = await new SubagentRunner(createTaskConfig(false), "reviewer", {
			name: "reviewer",
			description: "Review code",
			profile: "anthropic",
			tools: [ClineDefaultTool.ATTEMPT],
			systemPrompt: "Review carefully.",
		}).run("Review", progress)

		assert.equal(result.status, "completed", result.error)
		expect(progress.mock.calls[0]?.[0].runtime).toMatchObject({
			profileName: "anthropic",
			providerId: "anthropic",
			modelId: "anthropic/claude-sonnet-4.5",
			apiFormat: "anthropic_chat",
		})
	})

	it("switches a manual finish request to an attempt_completion-only next turn", async () => {
		let runner: SubagentRunner
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "toolu_finish_list",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[], tools: unknown[]) {
			const reminder = conversation.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
			assert.equal(reminder.role, "user")
			assert.match(reminder.content[0]?.text || "", /user requested/i)
			assert.match(reminder.content[0]?.text || "", /Do not call any other tool/i)
			assert.deepEqual(
				(tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
				[ClineDefaultTool.ATTEMPT],
			)
			yield {
				type: "tool_calls",
				function_id: "toolu_finish_complete",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "finished with current findings" }),
					},
				},
			}
		})
		vi.spyOn(systemPromptFacade, "getSystemPrompt").mockResolvedValue({
			systemPrompt: "system prompt",
			tools: [
				{ type: "function", function: { name: ClineDefaultTool.LIST_FILES, description: "List files" } },
				{ type: "function", function: { name: ClineDefaultTool.ATTEMPT, description: "Complete" } },
			] as never,
			profile: PromptProfile.Standard,
			warnings: [],
		})
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const config = createTaskConfig(true)
		vi.mocked(ListFilesToolHandler.prototype.execute).mockImplementation(async () => {
			assert.equal(await runner.requestFinish("user"), true)
			return "ok"
		})
		runner = new SubagentRunner(config)

		const result = await runner.run("Explore then finish", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, "finished with current findings")
		assert.equal(createMessage.mock.calls.length, 2)
	})

	it("passes prior request token totals into the next-turn compaction check", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "usage",
				inputTokens: 11,
				outputTokens: 7,
				cacheWriteTokens: 3,
				cacheReadTokens: 2,
			}
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_previous_tokens_1",
				tool_call: {
					function: {
						name: ClineDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_previous_tokens_complete_1",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(true)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(true))
		const scs = vi
			.spyOn(runner as unknown as SubagentRunnerTestAccess, "shouldCompactBeforeNextRequest")
			.mockImplementation((...args: unknown[]) => {
				assert.equal(args[0], 23)
				return false
			})
		const result = await runner.run("List files", () => {})
		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.equal(createMessage.mock.calls.length, 2)
		assert.equal(scs.mock.calls.length, 1)
	})

	it("uses the absolute cap with the shared 2K trigger tolerance", () => {
		stubApiHandler(vi.fn(), 1_000_000)
		const runner = new SubagentRunner(
			createTaskConfig(true, {
				useAutoCondense: true,
				autoCondenseTriggerPercent: 60,
				autoCondenseMinReserveTokens: 5_000,
				autoCondenseMaxReserveTokens: 30_000,
				autoCondenseMaxContextTokens: 500_000,
			}),
		)
		const probe = runner as unknown as {
			shouldCompactBeforeNextRequest: (
				requestTotalTokens: number,
				api: ReturnType<typeof coreApi.buildApiHandler>,
				modelId: string,
			) => boolean
		}
		const api = createContextApi(1_000_000)

		assert.equal(probe.shouldCompactBeforeNextRequest(494_499, api, "gpt-5.4-mini"), false)
		assert.equal(probe.shouldCompactBeforeNextRequest(494_500, api, "gpt-5.4-mini"), true)
	})

	it("uses the reserve pair when the context window equals the absolute cap", () => {
		stubApiHandler(vi.fn(), 272_000)
		const runner = new SubagentRunner(
			createTaskConfig(true, {
				useAutoCondense: true,
				autoCondenseTriggerPercent: 97,
				autoCondenseMinReserveTokens: 20_000,
				autoCondenseMaxReserveTokens: 30_000,
				autoCondenseMaxContextTokens: 272_000,
			}),
		)
		const probe = runner as unknown as {
			shouldCompactBeforeNextRequest: (
				requestTotalTokens: number,
				api: ReturnType<typeof coreApi.buildApiHandler>,
				modelId: string,
			) => boolean
		}
		const api = createContextApi(272_000)

		assert.equal(probe.shouldCompactBeforeNextRequest(246_499, api, "gpt-5.4-mini"), false)
		assert.equal(probe.shouldCompactBeforeNextRequest(246_500, api, "gpt-5.4-mini"), true)
	})

	it("retains standard truncation pressure when auto-compaction is disabled", () => {
		stubApiHandler(vi.fn(), 1_000_000)
		const runner = new SubagentRunner(createTaskConfig(true, { useAutoCondense: false }))
		const probe = runner as unknown as {
			shouldCompactBeforeNextRequest: (
				requestTotalTokens: number,
				api: ReturnType<typeof coreApi.buildApiHandler>,
				modelId: string,
			) => boolean
		}
		const api = createContextApi(1_000_000)

		assert.equal(probe.shouldCompactBeforeNextRequest(959_999, api, "gpt-5.4-mini"), false)
		assert.equal(probe.shouldCompactBeforeNextRequest(960_000, api, "gpt-5.4-mini"), true)
	})

	it("falls back to non-native result blocks if structured tool calls appear while native mode is disabled", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_2",
				tool_call: {
					function: {
						name: ClineDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
			const lm = c[c.length - 1] as TestConversationMessage
			assert.equal(lm.role, "user")
			assert.ok(lm.content.every((block) => block.type === "text"))
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_complete_2",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(false))
		const result = await runner.run("List files", () => {})
		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.equal(createMessage.mock.calls.length, 2)
	})

	it("requires attempt_completion after a plain assistant response", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "The review is complete." }
		})
		createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
			const reminder = conversation.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
			assert.equal(reminder.role, "user")
			assert.match(reminder.content[0]?.text || "", /Plain assistant text cannot complete a subagent run/)
			assert.match(reminder.content[0]?.text || "", /attempt_completion/)
			assert.match(reminder.content[0]?.text || "", /result/)
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_plain_text_complete",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.equal(createMessage.mock.calls.length, 2)
	})

	it("accepts the legacy response field for attempt_completion", async () => {
		const createMessage = vi.fn().mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_legacy_response",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ response: "legacy done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

		assert.equal(result.status, "completed")
		assert.equal(result.result, "legacy done")
		assert.equal(createMessage.mock.calls.length, 1)
	})

	it("requires a non-empty result after attempt_completion omits it", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_missing_result",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({}),
					},
				},
			}
		})
		createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
			const reminder = conversation.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
			assert.equal(reminder.role, "user")
			assert.match(reminder.content[0]?.text || "", /attempt_completion/)
			assert.match(reminder.content[0]?.text || "", /non-empty result/)
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_retry_result",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
	})

	it("bounds repeated empty attempt_completion calls instead of looping until timeout", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_missing_result_loop",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({}),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

		assert.equal(result.status, "failed")
		assert.match(result.error || "", /repeatedly called attempt_completion/)
		assert.equal(createMessage.mock.calls.length, 4)
	})

	it("reports the required completion protocol after repeated plain responses", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield { type: "text", text: "I am finished." }
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Review files", () => {})

		assert.equal(result.status, "failed")
		assert.match(result.error || "", /Plain assistant text cannot complete a subagent run/)
		assert.match(result.error || "", /attempt_completion/)
		assert.match(result.error || "", /result/)
	})

	it("retries empty assistant turns with a no-tools-used nudge before failing", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield* []
		})
		createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
			const la = c[1] as TestConversationMessage
			assert.equal(la.role, "assistant")
			assert.equal(la.content[0]?.type, "text")
			assert.equal(la.content[0]?.text, "Failure: I did not provide a response.")
			const lu = c[2] as TestConversationMessage
			assert.equal(lu.role, "user")
			assert.match(lu.content[0]?.text || "", /You did not use a tool/)
			yield {
				type: "tool_calls",
				function_id: "toolu_subagent_complete_3",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(false))
		const result = await runner.run("List files", () => {})
		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.equal(createMessage.mock.calls.length, 2)
	})

	it("retries initial stream failures before failing", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield* []
			throw new Error('{"code":"stream_initialization_failed","message":"Failed to create stream"}')
		})
		vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(false))
		const result = await runner.run("List files", () => {})
		assert.equal(result.status, "failed")
		assert.equal(result.retryable, true)
		assert.equal(createMessage.mock.calls.length, 6)
		assert.match(result.error || "", /stream_initialization_failed/i)
	})

	it("retries retryable initial API failures five times with cumulative progress events", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield* []
			throw new Error('{"code":"stream_initialization_failed","message":"Temporary provider failure"}')
		})
		const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfig(false))
		const progressEvents: Array<Record<string, unknown>> = []
		const result = await runner.run("Retry the provider request", (update) => {
			if (update.event) progressEvents.push(update.event as unknown as Record<string, unknown>)
		})

		assert.equal(result.status, "failed")
		assert.equal(result.retryable, true)
		assert.equal(createMessage.mock.calls.length, 6)
		assert.deepEqual(
			setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
			[5_000, 8_000, 11_000, 14_000, 17_000],
		)
		assert.deepEqual(progressEvents, [
			{ kind: "retry", retryAttempt: 1, maxRetries: 5, delayMs: 5_000, cumulativeDelayMs: 5_000 },
			{ kind: "retry", retryAttempt: 2, maxRetries: 5, delayMs: 8_000, cumulativeDelayMs: 13_000 },
			{ kind: "retry", retryAttempt: 3, maxRetries: 5, delayMs: 11_000, cumulativeDelayMs: 24_000 },
			{ kind: "retry", retryAttempt: 4, maxRetries: 5, delayMs: 14_000, cumulativeDelayMs: 38_000 },
			{ kind: "retry", retryAttempt: 5, maxRetries: 5, delayMs: 17_000, cumulativeDelayMs: 55_000 },
		])
		assert.match(result.error || "", /stream_initialization_failed|Temporary provider failure/i)
	})

	it.each([408, 409, 425])("retries HTTP %s before returning a retryable failure", async (status) => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield* []
			throw Object.assign(new Error(`${status} Temporary provider failure`), { status })
		})
		const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Retry the provider request", () => {})

		assert.equal(result.status, "failed")
		assert.equal(result.retryable, true)
		assert.equal(createMessage.mock.calls.length, 6)
		assert.deepEqual(
			setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
			[5_000, 8_000, 11_000, 14_000, 17_000],
		)
	})

	// BUGFIX-022: the real gateway payload observed in the field. `sequence_number: 0`
	// proves the failure happened before any semantic chunk, so the whole backoff
	// sequence should run. The previous allow-list classifier rejected it outright.
	it("retries an upstream stream_read_error reported as an SSE error event", async () => {
		const providerError = {
			error: { code: "stream_read_error", message: "stream_read_error", type: "upstream_error" },
			sequence_number: 0,
			type: "error",
		}
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield* []
			throw Object.assign(new Error("stream_read_error"), { code: "stream_read_error", error: providerError.error })
		})
		const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Reproduce stream_read_error", () => {})

		assert.equal(result.status, "failed")
		assert.equal(result.retryable, true)
		assert.equal(createMessage.mock.calls.length, 6)
		assert.deepEqual(
			setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
			[5_000, 8_000, 11_000, 14_000, 17_000],
		)
	})

	// The `response.failed` follow-up event carries only `upstream_error` plus a 502.
	it("retries an upstream_error reported through response.failed with HTTP 502", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield* []
			throw Object.assign(new Error("Upstream request failed"), { code: "upstream_error", status: 502 })
		})
		vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Reproduce upstream_error", () => {})

		assert.equal(result.status, "failed")
		assert.equal(result.retryable, true)
		assert.equal(createMessage.mock.calls.length, 6)
	})

	// A bare Error with no code and no status must still reach the backoff sequence.
	it("retries an unclassified provider error that carries neither code nor status", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield* []
			throw new Error("Upstream request failed")
		})
		vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Reproduce bare provider error", () => {})

		assert.equal(result.status, "failed")
		assert.equal(result.retryable, true)
		assert.equal(createMessage.mock.calls.length, 6)
	})

	it.each([
		["insufficient credits", { code: "insufficient_credits", details: { current_balance: 0 } }],
		["spend limit", { code: "SPEND_LIMIT_EXCEEDED" }],
		["inference cap", { code: "INFERENCE_CAP_ERROR" }],
		["auth", { status: 401 }],
	])("does not retry a non-recoverable %s failure", async (_label, errorShape) => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield* []
			throw Object.assign(new Error("Account level failure"), errorShape)
		})
		const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Account failure", () => {})

		assert.equal(result.status, "failed")
		assert.equal(result.retryable, false)
		assert.equal(createMessage.mock.calls.length, 1)
		assert.equal(setTimeoutSpy.mock.calls.length, 0)
	})

	it("retries a retryable failure after a usage-only prefix", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "usage", inputTokens: 10, outputTokens: 0 }
			throw Object.assign(new Error("408 Temporary provider failure"), { status: 408 })
		})
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "usage-prefix-complete",
				tool_call: { function: { name: ClineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
			}
		})
		vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Retry after usage", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(createMessage.mock.calls.length, 2)
	})

	it("retries an Anthropic nested service_unavailable error after a usage-only prefix", async () => {
		const createMessage = vi.fn()
		const providerError = {
			type: "error",
			error: { type: "service_unavailable", message: "Temporary Anthropic stream failure" },
			request_id: "req_usage_first",
		}
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "usage", inputTokens: 442_700, outputTokens: 0 }
			throw Object.assign(new Error(JSON.stringify(providerError)), {
				error: providerError,
				type: "service_unavailable",
			})
		})
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "anthropic-usage-prefix-complete",
				tool_call: { function: { name: ClineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
			}
		})
		vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Retry Anthropic usage prefix", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(createMessage.mock.calls.length, 2)
	})

	// BUGFIX-028: Anthropic adaptive thinking emits a thinking block before any answer.
	// `signature_delta` maps to a reasoning chunk whose text is empty, so the prefix carries
	// no observable output and the whole backoff sequence must still run.
	it("retries an upstream stream_read_error after an empty-content reasoning prefix", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield { type: "usage", inputTokens: 1_200, outputTokens: 0 }
			yield { type: "reasoning", reasoning: "Considering the request" }
			yield { type: "reasoning", reasoning: "", signature: "sig_adaptive" }
			throw Object.assign(new Error("stream_read_error"), {
				code: "stream_read_error",
				error: { code: "stream_read_error", message: "stream_read_error", type: "upstream_error" },
			})
		})
		const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Retry after reasoning prefix", () => {})

		assert.equal(result.status, "failed")
		assert.equal(result.retryable, true)
		assert.equal(createMessage.mock.calls.length, 6)
		assert.deepEqual(
			setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
			[5_000, 8_000, 11_000, 14_000, 17_000],
		)
	})

	// BUGFIX-028: Anthropic emits a standalone "\n" separator for text blocks at index > 0,
	// and Codex emits equivalent whitespace-only prefixes. Whitespace is not observable
	// output, so replaying it cannot duplicate anything the user has seen.
	it("retries an upstream stream_read_error after a whitespace-only text prefix", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield { type: "usage", inputTokens: 800, outputTokens: 0 }
			yield { type: "text", text: "\n" }
			throw Object.assign(new Error("stream_read_error"), { code: "stream_read_error" })
		})
		const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Retry after whitespace prefix", () => {})

		assert.equal(result.status, "failed")
		assert.equal(result.retryable, true)
		assert.equal(createMessage.mock.calls.length, 6)
		assert.deepEqual(
			setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
			[5_000, 8_000, 11_000, 14_000, 17_000],
		)
	})

	// BUGFIX-028 guard: once real assistant text is observable, replaying the attempt would
	// duplicate content. The retry sequence must stay disabled for that case.
	it("does not retry after observable assistant text has been produced", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield { type: "usage", inputTokens: 900, outputTokens: 0 }
			yield { type: "text", text: "Partial answer already streamed" }
			throw Object.assign(new Error("stream_read_error"), { code: "stream_read_error" })
		})
		const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Do not replay observable text", () => {})

		assert.equal(result.status, "failed")
		assert.equal(createMessage.mock.calls.length, 1)
		assert.deepEqual(
			setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
			[],
		)
	})

	it("retries structured Responses server errors before the first chunk", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield* []
			throw Object.assign(new Error("Responses API request failed: server_error: upstream exploded"), {
				name: "ResponsesApiError",
				code: "server_error",
				request_id: "req_failed_1",
				details: { code: "server_error", message: "upstream exploded" },
			})
		})
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "responses-server-error-complete",
				tool_call: { function: { name: ClineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
			}
		})
		vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Retry Responses server error", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(createMessage.mock.calls.length, 2)
	})

	it.each([
		"ECONNRESET",
		"UND_ERR_CONNECT_TIMEOUT",
		"UND_ERR_HEADERS_TIMEOUT",
		"UND_ERR_BODY_TIMEOUT",
		"UND_ERR_SOCKET",
	])("retries nested network cause code %s before the first chunk", async (causeCode) => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield* []
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: causeCode } })
		})
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "network-cause-complete",
				tool_call: { function: { name: ClineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
			}
		})
		vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Retry nested network error", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(createMessage.mock.calls.length, 2)
	})

	it("observes initial stream retries as attempts of one logical request and attaches final exact usage", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield* []
			throw Object.assign(new Error("408 Temporary provider failure"), { status: 408 })
		})
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "usage", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 }
			yield {
				type: "tool_calls",
				function_id: "toolu_round_complete",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		const attempts: number[] = []
		const exactUsages: unknown[] = []
		const completeProviderOnly = vi.fn()
		const completeTools = vi.fn()
		const completeTurnEndAwaitingUser = vi.fn()
		const admit = vi.fn(() => ({
			bindAttempt: <T>(stream: AsyncIterable<T>, taskAttempt: number) => {
				attempts.push(taskAttempt)
				return stream
			},
			attachExactUsage: (usage: unknown) => exactUsages.push(usage),
			completeProviderOnly,
			completeTools,
			completeTurnEndAwaitingUser,
		}))
		const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
			queueMicrotask(callback)
			return {} as NodeJS.Timeout
		}) as typeof setTimeout)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false, { providerRequestRounds: { admit } })).run(
			"Retry the provider request",
			() => {},
		)

		assert.equal(result.status, "completed")
		assert.equal(admit.mock.calls.length, 1)
		assert.deepEqual(attempts, [0, 1])
		assert.deepEqual(exactUsages, [
			{
				inputTokens: 100,
				outputTokens: 20,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				cacheUsageReported: true,
				totalCost: 0,
				currency: "USD",
			},
		])
		assert.deepEqual(
			setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
			[5_000],
		)
		assert.equal(completeProviderOnly.mock.calls.length, 0)
		assert.deepEqual(completeTools.mock.calls, [
			[
				{
					toolCount: 1,
					completedToolCount: 1,
					failedToolCount: 0,
					cancelledToolCount: 0,
				},
			],
		])
		assert.equal(completeTurnEndAwaitingUser.mock.calls.length, 0)
	})

	// BUGFIX-022: retry classification is a deny-list. Only account-level failures
	// that cannot recover by waiting short-circuit the backoff sequence.
	it.each([
		["authentication error", Object.assign(new Error("Unauthorized"), { status: 401 })],
	])("does not retry %s", async (_label, error) => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield* []
			throw error
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false)).run("Do not retry this", () => {})

		assert.equal(result.status, "failed")
		assert.equal(result.retryable, false)
		assert.equal(createMessage.mock.calls.length, 1)
	})

	it("finishes a pending retry wait through an attempt_completion-only next turn", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield* []
			throw new Error('{"code":"stream_initialization_failed","message":"Temporary provider failure"}')
		})
		createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[], tools: unknown[]) {
			const reminder = conversation.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
			assert.equal(reminder.role, "user")
			assert.match(reminder.content[0]?.text || "", /user requested/i)
			assert.deepEqual(
				(tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
				[ClineDefaultTool.ATTEMPT],
			)
			yield {
				type: "tool_calls",
				function_id: "toolu_retry_finish_complete",
				tool_index: 0,
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "finished after retry interruption" }),
					},
				},
			}
		})
		vi.spyOn(systemPromptFacade, "getSystemPrompt").mockResolvedValue({
			systemPrompt: "system prompt",
			tools: [
				{ type: "function", function: { name: ClineDefaultTool.LIST_FILES, description: "List files" } },
				{ type: "function", function: { name: ClineDefaultTool.ATTEMPT, description: "Complete" } },
			] as never,
			profile: PromptProfile.Standard,
			warnings: [],
		})
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfig(true))
		const runPromise = runner.run("Finish the provider retry", () => {})
		await vi.waitFor(() => assert.equal(createMessage.mock.calls.length, 1))
		assert.equal(await runner.requestFinish("user"), true)
		const result = await runPromise

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, "finished after retry interruption")
		assert.equal(createMessage.mock.calls.length, 2)
	})

	it("cancels a pending retry wait without issuing another API request", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield* []
			throw new Error('{"code":"stream_initialization_failed","message":"Temporary provider failure"}')
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfig(false))
		const runPromise = runner.run("Cancel the provider retry", () => {})
		await vi.waitFor(() => assert.equal(createMessage.mock.calls.length, 1))
		await runner.abort()
		const result = await runPromise

		assert.equal(result.status, "cancelled")
		assert.equal(createMessage.mock.calls.length, 1)
	})

	it("stops waiting for a hung tool once the run is aborted", async () => {
		// A tool call has no cancellation channel of its own, so a tool that never
		// settles (a shared parser lock, a stuck host request) used to hold the run
		// forever: the abort flag is only polled between tool calls, and that check
		// is never reached. Cancelling must abandon the wait and report cancelled.
		const config = createTaskConfig(true)
		let toolStarted: () => void = () => undefined
		const toolHasStarted = new Promise<void>((resolve) => {
			toolStarted = resolve
		})
		vi.spyOn(ListCodeDefinitionNamesToolHandler.prototype, "execute").mockImplementation(() => {
			toolStarted()
			// Never settles: the tool is wedged.
			return new Promise<string>(() => {})
		})
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "toolu_hung_tool",
				tool_call: {
					function: {
						name: ClineDefaultTool.LIST_CODE_DEF,
						arguments: JSON.stringify({ path: "." }),
					},
				},
			}
		})
		stubSystemPrompt(true)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(config)
		const runPromise = runner.run("Cancel a wedged tool", () => {})
		await toolHasStarted
		await runner.abort()

		const result = await Promise.race([
			runPromise,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("run did not settle after abort")), 5_000)),
		])

		assert.equal(result.status, "cancelled")
	})

	/** Collect every text block the runner sent as conversation on a given request. */
	function conversationTextForCall(createMessage: ReturnType<typeof vi.fn>, callIndex: number): string {
		const conversation = (createMessage.mock.calls[callIndex]?.[1] ?? []) as TestConversationMessage[]
		return conversation
			.flatMap((message) => message.content)
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n")
	}

	it("does not replay the provider request after a hosted Web Search chunk was yielded", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "server_tool",
				function_id: "hosted-search-before-stream-error",
				tool: ServerTool.WEB_SEARCH,
				phase: "started",
				input: { query: "Dline retry boundary" },
			}
			throw new Error("stream failed after hosted search started")
		})
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "" }
			yield {
				type: "tool_calls",
				function_id: "fc-done",
				dline_tid: "tid-done",
				tool_call: { function: { name: "attempt_completion", arguments: '{"result":"Reported the failure."}' } },
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage, 200_000, true)
		initializeHostProvider()
		const progress = vi.fn()
		const runner = new SubagentRunner(createTaskConfig(false, { clineWebToolsEnabled: true }), "web-researcher", {
			name: "web-researcher",
			description: "Researches current information on the web.",
			tools: [ClineDefaultTool.WEB_SEARCH, ClineDefaultTool.ATTEMPT],
			systemPrompt: "",
		})

		const result = await runner.run("Search once", progress)

		// The failed attempt is never replayed: the second call is a new turn that
		// carries the failure notice, not a retry of the same request.
		assert.equal(createMessage.mock.calls.length, 2)
		assert.equal(result.status, "completed")
		const hostedStartedEvents = progress.mock.calls
			.map(([update]) => update.event)
			.filter((event) => event?.kind === "tool_call" && event.toolName === "web_search" && event.toolStatus === "started")
		assert.equal(hostedStartedEvents.length, 1)
	})

	it("hands a failed hosted call back to the subagent instead of ending the run", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "server_tool",
				function_id: "hosted-search-recoverable",
				tool: ServerTool.WEB_SEARCH,
				phase: "started",
				input: { query: "Dline recovery boundary" },
			}
			throw new Error("stream failed after hosted search started")
		})
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "tool_calls",
				function_id: "fc-recovered",
				dline_tid: "tid-recovered",
				tool_call: {
					function: { name: "attempt_completion", arguments: '{"result":"Proceeded without the search."}' },
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage, 200_000, true)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(false, { clineWebToolsEnabled: true }), "web-researcher", {
			name: "web-researcher",
			description: "Researches current information on the web.",
			tools: [ClineDefaultTool.WEB_SEARCH, ClineDefaultTool.ATTEMPT],
			systemPrompt: "",
		})

		const result = await runner.run("Search once", vi.fn())

		assert.equal(result.status, "completed")
		assert.equal(result.result, "Proceeded without the search.")
		// The model must be told what failed, with the attempted query, so it can
		// decide whether to retry differently or continue without the result.
		const secondTurnText = conversationTextForCall(createMessage, 1)
		assert.match(secondTurnText, /Provider-hosted web search for "Dline recovery boundary" failed/i)
		assert.match(secondTurnText, /cannot be recovered automatically/i)
	})

	it("stops recovering once a run exhausts its hosted failure budget", async () => {
		const failingTurn = async function* () {
			yield {
				type: "server_tool",
				function_id: "hosted-search-always-failing",
				tool: ServerTool.WEB_SEARCH,
				phase: "started",
				input: { query: "never succeeds" },
			}
			throw new Error("stream failed after hosted search started")
		}
		const createMessage = vi.fn().mockImplementation(failingTurn)
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage, 200_000, true)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(false, { clineWebToolsEnabled: true }), "web-researcher", {
			name: "web-researcher",
			description: "Researches current information on the web.",
			tools: [ClineDefaultTool.WEB_SEARCH, ClineDefaultTool.ATTEMPT],
			systemPrompt: "",
		})

		const result = await runner.run("Search forever", vi.fn())

		// Recovery is bounded: a provider failing every attempt must end the run
		// rather than loop until the turn budget is exhausted.
		assert.equal(result.status, "failed")
		assert.equal(createMessage.mock.calls.length, 3)
		assert.match(result.error || "", /stream failed after hosted search started/i)
	})

	it("keeps propagating a stream failure when no hosted call was involved", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield { type: "text", text: "partial" }
			throw new Error("plain stream failure")
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage, 200_000, true)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(false, { clineWebToolsEnabled: true }), "web-researcher", {
			name: "web-researcher",
			description: "Researches current information on the web.",
			tools: [ClineDefaultTool.WEB_SEARCH, ClineDefaultTool.ATTEMPT],
			systemPrompt: "",
		})

		const result = await runner.run("Do not search", vi.fn())

		assert.equal(result.status, "failed")
		assert.match(result.error || "", /plain stream failure/i)
	})

	it("fails context window errors", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield* []
			const e = new Error("context length exceeded") as Error & { status: number }
			e.status = 400
			throw e
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(false))
		const result = await runner.run("Huge prompt", () => {})
		assert.equal(result.status, "failed")
		assert.equal(createMessage.mock.calls.length, 1)
		assert.match(result.error || "", /context length exceeded/i)
	})

	it("uses the configured task api handler for subagent requests", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "t1",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(true)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(true))
		const result = await runner.run("List files", () => {})
		assert.equal(result.status, "completed")
		assert.equal(createMessage.mock.calls.length, 1)
	})

	it("filters available skills to configured skills when subagent skills are configured", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "tsf1",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false, (context) => {
			assert.deepEqual(
				context.skills?.map((skill) => skill.name),
				["allowed-skill"],
			)
		})
		vi.spyOn(SubagentBuilder.prototype, "getConfiguredSkills").mockReturnValue(["allowed-skill"])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(
			createTaskConfig(false, {
				remoteGlobalSkills: [createRemoteSkillEntry("allowed-skill", "A"), createRemoteSkillEntry("other-skill", "O")],
			}),
		)
		const result = await runner.run("Run task", () => {})
		assert.equal(result.status, "completed")
		assert.equal(createMessage.mock.calls.length, 1)
	})

	it("uses request-frozen skill toggles instead of changed live toggle maps", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "frozen-skill-toggle",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(SubagentBuilder.prototype, "getConfiguredSkills").mockReturnValue(undefined)
		vi.spyOn(skills, "discoverAvailableSkills").mockImplementation(async (_cwd, toggles) => {
			assert.ok(toggles)
			assert.deepEqual(toggles.globalSkillsToggles, { frozen: true })
			assert.deepEqual(toggles.localSkillsToggles, { frozen: true })
			assert.deepEqual(toggles.remoteSkillsToggles, { frozen: true })
			return []
		})
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(
			createTaskConfig(false, {
				globalSkillsToggles: { live: false },
				localSkillsToggles: { live: false },
				remoteSkillsToggles: { live: false },
				taskGlobalSkillsToggles: { frozen: true },
				taskLocalSkillsToggles: { frozen: true },
				taskRemoteSkillsToggles: { frozen: true },
			}),
		)

		const result = await runner.run("Use frozen skill toggles", () => {})

		assert.equal(result.status, "completed", result.error)
	})

	it("uses all available skills when subagent skills are not configured", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "tsu1",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(false, (context) => {
			assert.deepEqual(
				context.skills?.map((skill) => skill.name),
				["alpha-skill", "beta-skill"],
			)
		})
		vi.spyOn(SubagentBuilder.prototype, "getConfiguredSkills").mockReturnValue(undefined)
		vi.spyOn(skills, "discoverAvailableSkills").mockResolvedValue([
			{ name: "alpha-skill", description: "A", path: "r:a", source: "global" },
			{ name: "beta-skill", description: "B", path: "r:b", source: "global" },
		])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(false))
		const result = await runner.run("Run task", () => {})
		assert.equal(result.status, "completed")
		assert.equal(createMessage.mock.calls.length, 1)
	})

	it("logs a warning when a configured skill is not available", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "tsm1",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		const warnStub = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
		stubSystemPrompt(false, (context) => {
			assert.deepEqual(
				context.skills?.map((skill) => skill.name),
				["present-skill"],
			)
		})
		vi.spyOn(SubagentBuilder.prototype, "getConfiguredSkills").mockReturnValue(["present-skill", "missing-skill"])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(
			createTaskConfig(false, {
				remoteGlobalSkills: [createRemoteSkillEntry("present-skill", "P")],
			}),
		)
		const result = await runner.run("Run task", () => {})
		assert.equal(result.status, "completed")
		assert.equal(createMessage.mock.calls.length, 1)
		assert.ok(
			warnStub.mock.calls.some((c) => c.some((a) => String(a).includes("missing-skill"))),
			"Expected warn about missing skill",
		)
	})

	it("includes enabled remote skills in subagent context and preserves configured remote names", async () => {
		const createMessage = vi.fn().mockImplementation(async function* () {
			yield {
				type: "tool_calls",
				function_id: "trs1",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		const remoteGlobalSkills = [
			createRemoteSkillEntry("remote-enabled", "E"),
			createRemoteSkillEntry("remote-disabled", "D"),
			createRemoteSkillEntry("remote-locked", "L", { alwaysEnabled: true }),
		]
		stubSystemPrompt(false, (context) => {
			assert.deepEqual(
				context.skills?.map((skill) => skill.name),
				["remote-enabled", "remote-locked"],
			)
		})
		vi.spyOn(SubagentBuilder.prototype, "getConfiguredSkills").mockReturnValue([
			"remote-enabled",
			"remote-disabled",
			"remote-locked",
		])
		vi.spyOn(skills, "discoverSkills").mockImplementation(async (_context, remoteEntries) => {
			assert.deepEqual(remoteEntries, remoteGlobalSkills)
			return [
				{
					name: "remote-enabled",
					description: "E",
					path: "r:re",
					source: "global",
				},
				{
					name: "remote-disabled",
					description: "D",
					path: "r:rd",
					source: "global",
				},
				{
					name: "remote-locked",
					description: "L",
					path: "r:rl",
					source: "global",
				},
			]
		})
		vi.spyOn(skills, "getAvailableSkills").mockImplementation((availableSkills) => availableSkills)
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(
			createTaskConfig(false, {
				remoteGlobalSkills,
				remoteSkillsToggles: {
					"remote-disabled": false,
					"remote-locked": false,
				},
			}),
		)
		const result = await runner.run("Run task", () => {})
		assert.equal(result.status, "completed")
		assert.equal(createMessage.mock.calls.length, 1)
	})

	it("injects and enforces the configured final output token budget", async () => {
		const longResult = "abcdefghij".repeat(100)
		const createMessage = vi.fn().mockImplementation(async function* (_systemPrompt: string, messages: unknown[]) {
			const initialUserMessage = messages[0] as { content: Array<{ type: string; text?: string }> }
			const initialText = initialUserMessage.content
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n")
			// Above MIN_SUBAGENT_OUTPUT_TOKENS so the configured value, not the
			// floor, is the effective budget under test.
			assert.match(initialText, /within 1,024 tokens/)
			yield {
				type: "tool_calls",
				function_id: "budget-complete",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: longResult }),
					},
				},
			}
		})
		stubSystemPrompt(false)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const result = await new SubagentRunner(createTaskConfig(false), "budget-agent", {
			name: "budget-agent",
			description: "Budget test agent",
			tools: [ClineDefaultTool.ATTEMPT],
			maxOutputTokens: 1_024,
			systemPrompt: "",
		}).run("Return a detailed report", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.ok(result.result)
		assert.ok(Buffer.byteLength(result.result ?? "", "utf8") <= 1_024 * 4)
	})

	it("includes workspace metadata only in the initial user message", async () => {
		const createMessage = vi.fn()
		createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
			const iu = c[0] as { role: string; content: Array<{ type: string; text?: string }> }
			assert.equal(iu.role, "user")
			assert.match(
				iu.content
					.filter((block) => block.type === "text")
					.map((block) => block.text || "")
					.join("\n"),
				/# Workspace Configuration/,
			)
			yield {
				type: "tool_calls",
				function_id: "tww1",
				tool_call: {
					function: {
						name: ClineDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
			const fu = c[2] as TestConversationMessage
			assert.equal(fu.role, "user")
			assert.equal(
				fu.content
					.filter((block) => block.type === "text")
					.map((block) => block.text || "")
					.join("\n")
					.includes("# Workspace Configuration"),
				false,
			)
			yield {
				type: "tool_calls",
				function_id: "twwc1",
				tool_call: {
					function: {
						name: ClineDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: "done" }),
					},
				},
			}
		})
		stubSystemPrompt(true)
		vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
		vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const runner = new SubagentRunner(createTaskConfig(true))
		const result = await runner.run("List files", () => {})
		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.equal(createMessage.mock.calls.length, 2)
	})
})
