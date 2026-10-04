import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { expect, it, vi } from "vitest"

const WARMUPS = 5
const MEASUREMENTS = 20
const TASK_ID = "ws051-prompt-context"
const CWD = resolve(process.cwd(), "tmp/ws051-runtime-performance/f0-workspace")
const WORKSPACE_NAME = "ws051-f0-workspace"

const f0 = vi.hoisted(() => {
	let tracing = false
	const calls: string[] = []
	const mark = (call: string): void => {
		if (tracing) calls.push(call)
	}

	return {
		beginTrace(): void {
			calls.length = 0
			tracing = true
		},
		endTrace(): readonly string[] {
			tracing = false
			return [...calls]
		},
		hostVersion: async () => {
			mark("host-version")
			return { platform: "WS051 Fixture IDE", version: "1.0.0", clineType: "VSCode Extension", clineVersion: "0.0.0" }
		},
		visibleTabs: async () => {
			mark("visible-tabs")
			return { paths: [] as string[] }
		},
		openTabs: async () => {
			mark("open-tabs")
			return { paths: [] as string[] }
		},
		refreshClineRules: async (cwd: string) => {
			mark(`refresh-cline-rules:${cwd}`)
			return { globalToggles: {}, localToggles: {} }
		},
		refreshExternalRules: async (cwd: string) => {
			mark(`refresh-external-rules:${cwd}`)
			return { windsurfLocalToggles: {}, cursorLocalToggles: {}, agentsLocalToggles: {} }
		},
		refreshWorkflows: async (cwd: string) => {
			mark(`refresh-workflows:${cwd}`)
			return { globalWorkflowToggles: {}, localWorkflowToggles: {} }
		},
		refreshSkills: async () => {
			mark("refresh-skills")
			return { globalSkills: [], localSkills: [] }
		},
		refreshSubagents: async () => {
			mark("refresh-subagents")
			return { globalSubagents: [], localSubagents: [] }
		},
		mcpServers: () => {
			mark("mcp-servers")
			return []
		},
		ensureRulesDirectory: async () => {
			mark("ensure-rules-directory")
			return "ws051-f0-global-rules"
		},
		globalRules: async () => {
			mark("load-global-rules")
			return { instructions: "" }
		},
		localRules: async () => {
			mark("load-local-rules")
			return { instructions: "" }
		},
		cursorRules: async () => {
			mark("load-cursor-rules")
			return ["", ""] as const
		},
		windsurfRules: async () => {
			mark("load-windsurf-rules")
			return ""
		},
		agentsRules: async () => {
			mark("load-agents-rules")
			return ""
		},
		discoverSkills: async () => {
			mark("discover-available-skills")
			return []
		},
		parentTaskId: (_taskId: string) => {
			mark("parent-task-id")
			return undefined
		},
		imageModelId: () => {
			mark("image-model-id")
			return undefined
		},
		ignoreContent: (_scope: string) => {
			mark("ignore-content")
			return undefined
		},
	}
})

vi.mock("@core/context/instructions/user-instructions/agent-rules", () => ({
	refreshClineRulesToggles: async (_controller: unknown, cwd: string) => f0.refreshClineRules(cwd),
	getGlobalClineRules: async () => f0.globalRules(),
	getLocalClineRules: async () => f0.localRules(),
}))

vi.mock("@core/context/instructions/user-instructions/external-rules", () => ({
	refreshExternalRulesToggles: async (_controller: unknown, cwd: string) => f0.refreshExternalRules(cwd),
	getLocalCursorRules: async () => f0.cursorRules(),
	getLocalWindsurfRules: async () => f0.windsurfRules(),
	getLocalAgentsRules: async () => f0.agentsRules(),
}))

vi.mock("@core/context/instructions/user-instructions/workflows", () => ({
	refreshWorkflowToggles: async (_controller: unknown, cwd: string) => f0.refreshWorkflows(cwd),
}))

vi.mock("@core/controller/file/refreshSkills", () => ({
	refreshSkills: async () => f0.refreshSkills(),
}))

vi.mock("@core/controller/file/refreshSubagents", () => ({
	refreshSubagents: async () => f0.refreshSubagents(),
}))

vi.mock("@core/context/instructions/user-instructions/skills", () => ({
	discoverAvailableSkills: async () => f0.discoverSkills(),
	getSkillContent: async () => {
		throw new Error("The fixed F0 prompt-context fixture must not load skill content")
	},
	parseRemoteSkillEntries: () => [],
}))

vi.mock("@core/storage/disk", () => ({
	GlobalFileNames: {
		agentsRulesDir: ".agents/rules",
		agentsRulesFile: "AGENTS.md",
		cursorRulesDir: ".cursor/rules",
		cursorRulesFile: ".cursorrules",
		windsurfRules: ".windsurfrules",
		taskSnapshot: "snapshot.json",
		taskActivities: "activities.json",
		taskContext: "context.json",
		apiConversationHistory: "api_conversation_history.jsonl",
		contextHistory: "context_history.jsonl",
		uiMessages: "ui_messages.jsonl",
		taskMetadata: "task_metadata.json",
	},
	ensureRulesDirectoryExists: async () => f0.ensureRulesDirectory(),
	ensureTaskDirectoryExists: async (taskId: string) => `ws051-f0-documents/tasks/${taskId}`,
	getSkillsDirectoriesForScan: () => [],
	getSubagentsScanDirectories: () => [],
	getWorkflowsScanDirectories: () => [],
	getDlineDataDir: () => "ws051-f0-data",
	getDlineDocumentsPath: async () => "ws051-f0-documents",
	getDlineDocumentsPathSync: () => "ws051-f0-documents",
	getDlineHomePath: () => "ws051-f0-home",
	getDocumentsPath: async () => "ws051-f0-documents-parent",
	warmupDocumentsPathCache: async () => undefined,
}))

vi.mock("@core/image-generation/runtime", () => ({
	resolveAvailableImageModelId: () => f0.imageModelId(),
	createImageProfileResolverForProfile: () => {
		throw new Error("The fixed F0 prompt-context fixture must not create an image profile resolver")
	},
	createImageGenerationRuntime: () => {
		throw new Error("The fixed F0 prompt-context fixture must not create an image generation runtime")
	},
}))

vi.mock("@/core/controller", () => ({ Controller: class Controller {} }))
vi.mock("@core/controller", () => ({ Controller: class Controller {} }))

vi.mock("@/core/orchestrator/OrchestratorController", () => ({
	OrchestratorController: {
		getInstance: () => ({ getParentTaskId: (taskId: string) => f0.parentTaskId(taskId) }),
	},
}))

interface PersistedTaskSettings {
	mode: "act"
	taskCapabilityToggles?: string
	setTaskCapabilityToggles(value: string): void
}

interface PromptBuildFixture {
	build(): Promise<unknown>
	readTaskCapabilityToggles(): string | undefined
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function normalizePromptContext(value: unknown): Record<string, unknown> {
	const context = value as Record<string, unknown>
	return {
		...context,
		enableNativeToolCalls: context.enableNativeToolCalls === true,
		enableParallelToolCalling: context.enableParallelToolCalling === true,
	}
}

function createStateManager(): Record<string, unknown> {
	const settings: Record<string, unknown> = {
		browserSettings: { disableToolUse: false, viewport: { width: 1280, height: 800 } },
		preferredLanguage: "English",
		lazyTeammateModeEnabled: false,
		mcpEnabled: false,
		focusChainSettings: { enabled: false, remindClineInterval: 6 },
		yoloModeToggled: false,
		subagentsEnabled: true,
		defaultTerminalProfile: "default",
		terminalCommandTimeoutSeconds: 30,
		enableParallelToolCalling: false,
	}
	return {
		getGlobalSettingsKey: (key: string) => settings[key],
		getGlobalStateKey: (_key: string) => undefined,
		getCanonicalSettingsKey: (_key: string) => false,
		getRemoteConfigSettings: () => ({
			remoteGlobalRules: [],
			remoteGlobalWorkflows: [],
			remoteGlobalSkills: [],
		}),
	}
}

function createTaskSettings(): PersistedTaskSettings {
	return {
		mode: "act",
		taskCapabilityToggles: undefined,
		setTaskCapabilityToggles(value: string): void {
			this.taskCapabilityToggles = value
		},
	}
}

function providerInfo(): Record<string, unknown> {
	return {
		providerId: "ws051-deterministic-provider",
		model: {
			id: "ws051-context-model",
			info: {
				capabilities: {
					contextWindow: 200_000,
					supportsBrowserAction: false,
					supportsImages: false,
					supportsTools: false,
				},
			},
		},
		mode: "act",
	}
}

function routingPlan(): Record<string, unknown> {
	return {
		mode: 0,
		route: "disabled",
		webFetchRoute: "disabled",
		serverToolPlan: { declared: [], disabled: [], active: [], unsupported: [], unrecognized: [] },
		localToolEnabled: false,
		localFallbackAvailable: false,
		serverTools: [],
	}
}

async function installHostProvider(): Promise<void> {
	const { HostProvider } = (await import("@/hosts/host-provider")) as {
		HostProvider: {
			reset(): void
			initialize(...args: unknown[]): unknown
		}
	}
	HostProvider.reset()
	HostProvider.initialize(
		() => ({}),
		() => ({}),
		() => ({}),
		() => ({}),
		{
			envClient: { getHostVersion: () => f0.hostVersion() },
			windowClient: {
				getVisibleTabs: () => f0.visibleTabs(),
				getOpenTabs: () => f0.openTabs(),
			},
			workspaceClient: {},
			diffClient: {},
			languageClient: {},
		},
		() => undefined,
		async () => "",
		async () => "",
		process.cwd(),
		process.cwd(),
	)
}

async function createCandidateFixture(entry: unknown): Promise<PromptBuildFixture> {
	const { TaskPromptContextOwner } = entry as {
		TaskPromptContextOwner: new (options: unknown) => { build(...args: unknown[]): Promise<unknown> }
	}
	const [toggles, modelUtils] = await Promise.all([import("@shared/TaskCapabilityToggles"), import("@/utils/model-utils")])
	const taskSettings = createTaskSettings()
	const stateManager = createStateManager()
	const workspaceRoot = { path: CWD, name: WORKSPACE_NAME }
	const owner = new TaskPromptContextOwner({
		identity: { taskId: TASK_ID, cwd: CWD },
		host: {
			getHostVersion: () => f0.hostVersion(),
			refreshClineRules: (cwd: string) => f0.refreshClineRules(cwd),
			refreshExternalRules: (cwd: string) => f0.refreshExternalRules(cwd),
			refreshWorkflows: (cwd: string) => f0.refreshWorkflows(cwd),
			refreshSkills: () => f0.refreshSkills(),
			refreshSubagents: () => f0.refreshSubagents(),
			getMcpServers: () => f0.mcpServers(),
		},
		stateManager,
		taskStateManager: taskSettings,
		getMessageStateHandler: () => ({ clineMessages: [] }),
		workspace: {
			ignoreController: { getIgnoreContent: (scope: string) => f0.ignoreContent(scope) },
			manager: {
				getRoots: () => [workspaceRoot],
				getPrimaryRoot: () => workspaceRoot,
			},
			getPrimaryWorkspaceName: () => WORKSPACE_NAME,
		},
		runtime: {
			getMode: () => "act",
			getTaskCapabilityToggles: () =>
				toggles.parseTaskCapabilityToggles(taskSettings.taskCapabilityToggles) ?? toggles.emptyTaskCapabilityToggles(),
			shouldUseNativeToolCalls: (info: unknown) => modelUtils.isNativeToolCallingConfig(info as never, false),
			resolveParallelToolCallingEnabled: (info: unknown) => modelUtils.isParallelToolCallingEnabled(false, info as never),
			getParentTaskId: async () => f0.parentTaskId(TASK_ID),
		},
		terminalExecutionMode: "vscodeTerminal",
	})
	const info = providerInfo()
	const plan = routingPlan()
	return {
		build: () => owner.build(info as never, false, plan as never),
		readTaskCapabilityToggles: () => taskSettings.taskCapabilityToggles,
	}
}

async function createLegacyFixture(entry: unknown): Promise<PromptBuildFixture> {
	const { Task } = entry as { Task: { prototype: Record<string, unknown> } }
	const taskSettings = createTaskSettings()
	const stateManager = createStateManager()
	const workspaceRoot = { path: CWD, name: WORKSPACE_NAME }
	const fakeTask = Object.assign(Object.create(Task.prototype), {
		taskId: TASK_ID,
		cwd: CWD,
		stateManager,
		taskSm: taskSettings,
		controller: {
			mcpOwnerId: "ws051-owner",
			getMcpServersForOwner: () => f0.mcpServers(),
		},
		messageStateHandler: { clineMessages: [] },
		workspaceManager: {
			getRoots: () => [workspaceRoot],
			getPrimaryRoot: () => workspaceRoot,
		},
		ignoreController: { getIgnoreContent: (scope: string) => f0.ignoreContent(scope) },
		terminalExecutionMode: "vscodeTerminal",
	}) as Record<string, unknown>
	const buildPromptContext = Task.prototype.buildPromptContext as (
		this: Record<string, unknown>,
		providerInfo: unknown,
		webToolsEnabled: boolean,
		webSearchRoutingPlan: unknown,
	) => Promise<unknown>
	if (typeof buildPromptContext !== "function") throw new Error("Legacy Task.buildPromptContext is unavailable")
	const info = providerInfo()
	const plan = routingPlan()
	return {
		build: () => buildPromptContext.call(fakeTask, info, false, plan),
		readTaskCapabilityToggles: () => taskSettings.taskCapabilityToggles,
	}
}

it("measures an equivalent fixed-F0 prompt/context build", async () => {
	const entry = await import("@perf/prompt-context-entry")
	await installHostProvider()
	const variant = process.env.WS051_VARIANT
	const fixture = variant === "candidate" ? await createCandidateFixture(entry) : await createLegacyFixture(entry)

	f0.beginTrace()
	const preflightContext = await fixture.build()
	const normalizedContext = normalizePromptContext(preflightContext)
	const callTrace = f0.endTrace()
	const taskCapabilityToggles = fixture.readTaskCapabilityToggles()
	if (!taskCapabilityToggles) throw new Error("Prompt/context build did not persist task capability toggles")

	for (let index = 0; index < WARMUPS; index++) await fixture.build()
	const samplesMs: number[] = []
	for (let index = 0; index < MEASUREMENTS; index++) {
		const started = process.hrtime.bigint()
		await fixture.build()
		samplesMs.push(Number(process.hrtime.bigint() - started) / 1_000_000)
	}

	expect(samplesMs).toHaveLength(MEASUREMENTS)
	expect(samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(true)
	console.log(
		`WS051_SAMPLE ${JSON.stringify({
			metric: "prompt_context",
			variant,
			pid: process.pid,
			runId: process.env.WS051_RUN_ID,
			warmups: WARMUPS,
			measurements: MEASUREMENTS,
			samplesMs,
			contextDigest: digest(normalizedContext),
			contextBytes: Buffer.byteLength(JSON.stringify(normalizedContext)),
			context: normalizedContext,
			rawContextDigest: digest(preflightContext),
			rawContextBytes: Buffer.byteLength(JSON.stringify(preflightContext)),
			rawContext: preflightContext,
			callDigest: digest(callTrace),
			callTrace,
			taskCapabilityToggles,
		})}`,
	)
})
