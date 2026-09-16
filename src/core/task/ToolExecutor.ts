import path from "node:path"
import { ApiHandler, resolveProviderFromProfile } from "@core/api"
import type { WebSearchRoutingPlan } from "@core/api/server-tools"
import type { IdentityFactory } from "@core/api/transform/block-identity"
import type { ApiStreamServerToolChunk } from "@core/api/transform/stream"
import { isTaskReadScopePath } from "@core/artifacts/runtime"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { IgnoreController } from "@core/ignore/IgnoreController"
import type { ImageGenerationService } from "@core/image-generation/ImageGenerationService"
import { createImageGenerationRuntime } from "@core/image-generation/runtime"
import { CommandPermissionController } from "@core/permissions"
import type { ResolvedPromptRuntime } from "@core/prompts/system-prompt-cache/FrozenPromptRuntime"
import { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { CommandCancellationResult, CommandExecutionOptions, CommandExecutionOutcome } from "@integrations/terminal"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { McpHub } from "@services/mcp/McpHub"
import { DlineRuntimeFileManager } from "@services/runtime-files/DlineRuntimeFileManager"
import { recordPerfPhase } from "@services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@services/telemetry/instrumentation/perf-domains"
import { runWithSignalSpan, startSignalSpan } from "@services/telemetry/service/pipeline-port"
import { DEFAULT_API_PROVIDER } from "@shared/api"
import type { ClineExtensionContext } from "@shared/cline/context"
import {
	describeCodeExecutionOperation,
	normalizeCodeExecutionErrorCode,
	normalizeCodeExecutionOutput,
	normalizeHostedCodeExecutionOperation,
} from "@shared/code-execution-tools"
import { ClineAsk, ClineSay, ClineSayTool, type CommandStatus } from "@shared/ExtensionMessage"
import { ClineContent, type ClineToolResponseContent, type ClineUserToolResultContentBlock } from "@shared/messages/content"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { Logger } from "@shared/services/Logger"
import type { Mode } from "@shared/storage/types"
import type { TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { ClineDefaultTool, toolUseNames } from "@shared/tools"
import { ClineAskResponse } from "@shared/WebviewMessage"
import { normalizeWebSearchItems } from "@shared/web-tools"
import { isParallelToolCallingEnabled, modelDoesntSupportWebp } from "@/utils/model-utils"
import { isLocatedInPath } from "@/utils/path"
import { ToolUse } from "../assistant-message"
import { ContextManager } from "../context/context-management/ContextManager"
import { formatResponse } from "../prompts/responses"
import { StateManager } from "../storage/StateManager"
import { WorkspaceRootManager } from "../workspace"
import type { TaskActivityStore } from "./activity/TaskActivityStore"
import { isTurnEndingToolName } from "./assistant-message-order"
import { BlockPhase } from "./BlockPhaseMachine"
import { serializeDurableToolResult } from "./DurableToolResult"
import { authorizeExplicitToolExecution } from "./explicit-instructions/explicit-tool-gate"
import { isExplicitOnlyTool } from "./explicit-instructions/policy"
import type { ExplicitInstructionConsumePort } from "./explicit-instructions/types"
import { hasValidTodoItem, isAllItemsCompleted } from "./focus-chain/file-utils"
import type { InteractionKind } from "./interaction/Interaction"
import { isInteractionCancellationError } from "./interaction/InteractionCancellationError"
import type { InteractionOutcome } from "./interaction/InteractionCoordinator"
import { isTurnEndContinuationHandler, requiresTurnEndContinuation } from "./interaction/TurnEndContinuationRegistry"
import { checkRepeatedToolCall, LOOP_DETECTION_SOFT_THRESHOLD, toolCallSignature } from "./loop-detection"
import { MessageStateHandler } from "./message-state"
import type { ProviderRequestRoundPort } from "./performance/provider-request-round-port"
import { resolveRequestWebSearchRoutingPlan } from "./RequestApiScope"
import { TaskController } from "./TaskController"
import { TaskState } from "./TaskState"
import { canonicalizeAttemptCompletionParams } from "./tools/attempt-completion-params"
import { AutoApprove } from "./tools/autoApprove"
import { type HostedImageGenerationContext, HostedImageGenerationLifecycle } from "./tools/HostedImageGenerationLifecycle"
import { isInternalNativeToolName, normalizeNativeToolName } from "./tools/NativeToolAdmission"
import { type HostedServerToolUpdate, ServerToolLifecycle } from "./tools/ServerToolLifecycle"
import { SubagentJobManager } from "./tools/subagent/SubagentJobManager"
import { normalizeToolExecutionResult, type ToolPostCommitDirective } from "./tools/ToolExecutionResult"
import { type IPartialBlockHandler, ToolExecutorCoordinator } from "./tools/ToolExecutorCoordinator"
import { ToolValidator } from "./tools/ToolValidator"
import { ToolDurationScope } from "./tools/tool-duration-scope"
import {
	type CompactionAttemptGuard,
	type TaskConfig,
	type TaskInteractionPorts,
	validateTaskConfig,
} from "./tools/types/TaskConfig"
import { createUIHelpers } from "./tools/types/UIHelpers"
import { ToolDisplayUtils } from "./tools/utils/ToolDisplayUtils"
import { NO_TOOL_RESULT, ToolResultUtils } from "./tools/utils/ToolResultUtils"

type ToolResponse = ClineToolResponseContent

export { canonicalizeAttemptCompletionParams } from "./tools/attempt-completion-params"

/**
 * Resolve whether a tool use should be auto-approved from tool params.
 * @param toolName Tool name from the assistant block.
 * @param params Tool parameters from the assistant block.
 * @param autoApproveResult Auto-approve setting result for the tool.
 * @returns True when the block should skip manual approval.
 */
export function isToolUseAutoApproved(
	toolName: ClineDefaultTool,
	params: ToolUse["params"] | undefined,
	autoApproveResult: boolean | [boolean, boolean],
): boolean {
	if (toolName === ClineDefaultTool.BASH) {
		const [autoApproveSafe, autoApproveAll] = Array.isArray(autoApproveResult)
			? autoApproveResult
			: [autoApproveResult, false]
		const requiresApprovalRaw = params?.requires_approval
		const requiresApprovalPerLLM = requiresApprovalRaw?.toLowerCase() === "true"
		return (!requiresApprovalPerLLM && autoApproveSafe) || (requiresApprovalPerLLM && autoApproveSafe && autoApproveAll)
	}

	if (Array.isArray(autoApproveResult)) {
		return autoApproveResult[0] || autoApproveResult[1]
	}
	return !!autoApproveResult
}

interface BlockApproveOptions {
	cwd: string
	autoApproveResult: boolean | [boolean, boolean]
	workspaceRoots?: string[]
	taskId?: string
}

const PATH_AUTO_APPROVE_TOOLS = new Set<ClineDefaultTool>([
	ClineDefaultTool.FILE_READ,
	ClineDefaultTool.LIST_FILES,
	ClineDefaultTool.LIST_CODE_DEF,
	ClineDefaultTool.SEARCH,
])

/**
 * Extract the filesystem path parameter used for path-scoped auto-approval.
 * @param block Tool use block emitted by the assistant.
 * @returns Path parameter when the tool is path-scoped, otherwise undefined.
 */
function getApprovePath(block: ToolUse): string | undefined {
	if (!PATH_AUTO_APPROVE_TOOLS.has(block.name)) {
		return undefined
	}
	return block.params?.path
}

/**
 * Resolve whether a path-scoped tool use is inside the workspace roots.
 * @param cwd Primary workspace path.
 * @param toolPath Tool path parameter supplied by the assistant.
 * @param workspaceRoots Optional workspace roots for multi-root workspaces.
 * @returns True when the resolved path is inside any workspace root.
 */
function isLocalPath(
	cwd: string,
	toolName: ClineDefaultTool,
	toolPath: string,
	workspaceRoots?: string[],
	taskId?: string,
): boolean {
	const absolutePath = path.isAbsolute(toolPath) ? path.resolve(toolPath) : path.resolve(cwd, toolPath)
	const roots = workspaceRoots && workspaceRoots.length > 0 ? workspaceRoots : [cwd]
	const isTaskScopedRead =
		toolName === ClineDefaultTool.FILE_READ && taskId !== undefined && isTaskReadScopePath(taskId, absolutePath)
	return (
		DlineRuntimeFileManager.isManagedPath(absolutePath) ||
		isTaskScopedRead ||
		roots.some((root) => isLocatedInPath(root, absolutePath))
	)
}

/**
 * Resolve whether a complete tool block should skip manual approval.
 * @param block Complete tool use block with params.
 * @param options Workspace and auto-approval settings for this task.
 * @returns True when the block is safe to auto-execute.
 */
export function isBlockAutoApproved(block: ToolUse, options: BlockApproveOptions): boolean {
	const toolPath = getApprovePath(block)
	if (!toolPath) {
		return PATH_AUTO_APPROVE_TOOLS.has(block.name)
			? false
			: isToolUseAutoApproved(block.name, block.params, options.autoApproveResult)
	}

	const [autoApproveLocal, autoApproveExternal] = Array.isArray(options.autoApproveResult)
		? options.autoApproveResult
		: [options.autoApproveResult, false]
	const isLocal = isLocalPath(options.cwd, block.name, toolPath, options.workspaceRoots, options.taskId)
	return (isLocal && autoApproveLocal) || (!isLocal && autoApproveLocal && autoApproveExternal)
}

/** Present one hosted Web Search call. */
function buildWebSearchMessage(update: HostedServerToolUpdate, providerId: string, providerLabel: string): ClineSayTool {
	const items = normalizeWebSearchItems(update.result)
	return {
		tool: "webSearch",
		path: update.query,
		content:
			update.status === "failed" ? `Web search failed: ${update.error ?? update.query}` : `Searching for: ${update.query}`,
		operationIsLocatedInWorkspace: false,
		webSearch: {
			schemaVersion: 1,
			status: update.status === "failed" ? "failed" : update.status === "completed" ? "completed" : "running",
			source: {
				id: `${providerId}-hosted`,
				label: `${providerLabel} Web Search`,
				execution: "hosted",
				provider: providerId,
			},
			query: update.query,
			operation: update.operation,
			...(items.length > 0 ? { items } : {}),
			...(update.error === undefined ? {} : { error: update.error }),
		},
	}
}

/**
 * Present one provider-hosted sandbox run.
 *
 * The sandbox executes remotely, so the submitted code and the captured streams
 * are the only evidence available when a run misbehaves; both are carried here
 * rather than reduced to a status line.
 */
function buildCodeExecutionMessage(update: HostedServerToolUpdate, providerId: string, providerLabel: string): ClineSayTool {
	const operation = normalizeHostedCodeExecutionOperation(update.input)
	const output = normalizeCodeExecutionOutput(update.result)
	const errorCode = normalizeCodeExecutionErrorCode(update.errorDetail)
	const description = describeCodeExecutionOperation(operation)

	return {
		tool: "codeExecution",
		path: description ?? update.query,
		content:
			update.status === "failed"
				? `Code execution failed: ${errorCode ?? update.error ?? "unknown error"}`
				: (description ?? "Running code"),
		operationIsLocatedInWorkspace: false,
		codeExecution: {
			schemaVersion: 1,
			status: update.status === "failed" ? "failed" : update.status === "completed" ? "completed" : "running",
			source: {
				id: `${providerId}-hosted`,
				label: `${providerLabel} Code Execution`,
				execution: "hosted",
				provider: providerId,
			},
			operation,
			...(output === undefined ? {} : { output }),
			...(errorCode === undefined ? {} : { errorCode }),
			...(update.error === undefined ? {} : { error: update.error }),
		},
	}
}

export class ToolExecutor {
	private autoApprover: AutoApprove
	/** Assigned by the Task composition root after construction. */
	private _controllerContext?: ClineExtensionContext
	private coordinator: ToolExecutorCoordinator
	private subagentJobManager = new SubagentJobManager()
	private allowedNativeToolNames: ReadonlySet<string> | undefined
	private webToolsEnabled: boolean | undefined
	private webSearchRoutingPlan: WebSearchRoutingPlan | undefined
	private promptRuntime: ResolvedPromptRuntime | undefined
	private explicitInstructions: ExplicitInstructionConsumePort | undefined
	private hostedServerToolLifecycle: ServerToolLifecycle | undefined
	private hostedImageGenerationLifecycle: HostedImageGenerationLifecycle | undefined
	private readonly postCommitDirectives = new Map<string, ToolPostCommitDirective>()
	private readonly imageGenerationService: ImageGenerationService

	/** Public accessor for auto-approve logic used by TaskController.buildTurn(). */
	public isAutoApproved(toolName: ClineDefaultTool, params?: ToolUse["params"]): boolean {
		const result = this.autoApprover.shouldAutoApproveTool(toolName)
		return isToolUseAutoApproved(toolName, params, result)
	}

	/** Public block-scoped accessor used by TaskController.buildTurn(). */
	public isBlockApproved(block: ToolUse): boolean {
		// Invalid and internal native calls must enter execution so they can be
		// closed with a paired result instead of becoming orphan approval blocks.
		if (
			block.isNativeToolCall &&
			(isInternalNativeToolName(block.name) || !this.isNativeToolAdmitted(block.name) || !this.coordinator.has(block.name))
		) {
			return true
		}
		// Registered handlers own their approval transaction. The canonical runtime
		// must start the handler so it can present the matching interaction and wait
		// for the user's causal response; gating here would prevent that interaction
		// from ever being rendered.
		if (this.coordinator.has(block.name)) {
			return true
		}
		const result = this.autoApprover.shouldAutoApproveTool(block.name)
		const workspaceRoots = this.workspaceManager?.getRoots().map((root) => root.path)
		return isBlockAutoApproved(block, {
			cwd: this.cwd,
			autoApproveResult: result,
			workspaceRoots,
			taskId: this.taskId,
		})
	}

	/**
	 * Get the task-local background subagent job manager.
	 * @returns Subagent job manager owned by this tool executor.
	 */
	public getSubagentJobManager(): SubagentJobManager {
		return this.subagentJobManager
	}

	/** Rebind one persisted failed subagent before the Activity Retry action runs. */
	public restoreSubagentRetry(activityId: string): Promise<boolean> {
		return this.coordinator.restoreSubagentRetry(this.asToolConfig(), activityId)
	}

	/** Freeze the ordinary native functions exposed in the current API request. */
	public setAllowedNativeToolNames(toolNames: ReadonlySet<string>): void {
		this.allowedNativeToolNames = new Set(Array.from(toolNames, normalizeNativeToolName))
	}

	/** Freeze explicit-only tool authority for the current provider attempt. */
	public setExplicitInstructionConsumePort(port: ExplicitInstructionConsumePort): void {
		this.explicitInstructions = port
	}

	/** Return whether the current request attempt may render an explicit-only tool while it is still partial. */
	private canRenderExplicitTool(toolName: ClineDefaultTool): boolean {
		if (!isExplicitOnlyTool(toolName)) return true
		return this.explicitInstructions?.getPendingToolAuthorization(toolName) !== undefined
	}

	/** Freeze the complete prompt-visible execution projection for the current Provider input. */
	public setPromptRuntime(runtime: ResolvedPromptRuntime, allowHosted = true): void {
		this.setWebSearchRoutingPlan(runtime.webSearchRoutingPlan, runtime.webToolsEnabled, allowHosted)
		this.promptRuntime = runtime
	}

	/** Set the legacy Web-only projection and clear any complete runtime left by an earlier request. */
	public setWebSearchRoutingPlan(plan: WebSearchRoutingPlan, webToolsEnabled: boolean, allowHosted = true): void {
		this.promptRuntime = undefined
		this.webToolsEnabled = webToolsEnabled
		this.webSearchRoutingPlan = plan
		this.hostedServerToolLifecycle = new ServerToolLifecycle(plan, allowHosted, async (update) => {
			const providerId = this.api.getProviderId?.() ?? "provider"
			const providerLabel = providerId === "openai" ? "OpenAI" : providerId === "deepseek" ? "DeepSeek" : providerId
			// Each hosted tool reports a differently shaped payload, so the message is
			// built from the tool that actually ran rather than a single fixed shape.
			const message =
				update.tool === ServerTool.CODE_EXECUTION
					? buildCodeExecutionMessage(update, providerId, providerLabel)
					: buildWebSearchMessage(update, providerId, providerLabel)
			const messageTs = await this.say(
				"tool",
				JSON.stringify(message),
				undefined,
				undefined,
				update.partial,
				this.hostedServerToolMessageTs.get(update.dlineTid),
			)
			if (messageTs !== undefined) this.hostedServerToolMessageTs.set(update.dlineTid, messageTs)
		})
		this.hostedServerToolMessageTs.clear()
	}

	private hostedServerToolMessageTs = new Map<string, number>()
	private hostedImageGenerationMessageTs = new Map<string, number>()

	/** Freeze the provider-hosted image route for the current Provider input. */
	public setHostedImageGenerationContext(context: HostedImageGenerationContext): void {
		this.hostedImageGenerationLifecycle = new HostedImageGenerationLifecycle({
			taskId: this.taskId,
			context,
			onUpdate: async (update) => {
				const messageTs = await this.say(
					"tool",
					JSON.stringify(update.message),
					undefined,
					undefined,
					update.partial,
					this.hostedImageGenerationMessageTs.get(update.dlineTid),
				)
				if (messageTs !== undefined) this.hostedImageGenerationMessageTs.set(update.dlineTid, messageTs)
			},
		})
		this.hostedImageGenerationMessageTs.clear()
	}

	/** Route one normalized provider-hosted event through the task's tool executor. */
	public async consumeServerToolChunk(chunk: ApiStreamServerToolChunk): Promise<boolean> {
		if (await this.hostedImageGenerationLifecycle?.consume(chunk)) return true
		return (await this.hostedServerToolLifecycle?.consume(chunk)) ?? false
	}

	/** Close open hosted calls when the provider stream ends, fails, or is cancelled. */
	public async finalizeServerToolCalls(reason: string): Promise<void> {
		await this.hostedImageGenerationLifecycle?.finalizeOpen()
		await this.hostedServerToolLifecycle?.finalizeOpen(reason)
	}

	/** Use live settings only for restored approvals that no longer have a request scope. */
	private getWebToolsEnabledForExecution(): boolean {
		if (this.promptRuntime) return this.promptRuntime.webToolsEnabled
		if (this.webToolsEnabled !== undefined) return this.webToolsEnabled
		return this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true
	}

	private getFocusChainEnabledForExecution(): boolean {
		return (
			this.promptRuntime?.focusChainEnabled ??
			this.stateManager.getGlobalSettingsKey("focusChainSettings")?.enabled === true
		)
	}

	/** Resolve a route for restored tool approvals that no longer have their live request scope. */
	private getWebSearchRoutingPlanForExecution(
		webToolsEnabled = this.getWebToolsEnabledForExecution(),
	): WebSearchRoutingPlan | undefined {
		if (this.webSearchRoutingPlan) return this.webSearchRoutingPlan
		if (typeof this.api?.getModel !== "function") return undefined
		return resolveRequestWebSearchRoutingPlan(this.api, webToolsEnabled)
	}

	private isNativeToolAdmitted(toolName: string): boolean {
		// A reopened task has no live request scope. Its persisted approval
		// interaction remains executable so an explicit Approve action still works.
		return this.allowedNativeToolNames === undefined || this.allowedNativeToolNames.has(normalizeNativeToolName(toolName))
	}

	private canFallbackUnadvertisedWebSearch(config: TaskConfig): boolean {
		const plan = config.webSearchRoutingPlan
		return (
			config.webToolsEnabled === true &&
			plan?.mode === WebToolsMode.WEB_TOOLS_MODE_AUTO &&
			plan.route === "hosted" &&
			plan.localFallbackAvailable &&
			this.coordinator.has(ClineDefaultTool.WEB_SEARCH)
		)
	}

	private createLocalWebSearchFallbackConfig(config: TaskConfig): TaskConfig {
		const plan = config.webSearchRoutingPlan
		if (!plan) return config
		return {
			...config,
			webSearchRoutingPlan: Object.freeze({
				...plan,
				route: "local" as const,
				localToolEnabled: true,
				serverTools: Object.freeze([]),
			}),
		}
	}

	private async presentUnadvertisedHostedWebSearch(block: ToolUse, fallback: boolean, mode: WebToolsMode): Promise<string> {
		const providerId = this.api.getProviderId?.() ?? "provider"
		const providerLabel = providerId === "openai" ? "OpenAI" : providerId === "deepseek" ? "DeepSeek" : providerId
		const query =
			typeof block.params?.query === "string" && block.params.query.trim() ? block.params.query.trim() : "Web search"
		const message = fallback
			? `${providerLabel} hosted Web Search returned a local web_search function call instead of a hosted search event; falling back to Dline local Web Search.`
			: mode === WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE
				? `${providerLabel} hosted Web Search returned a local web_search function call, but the request is configured for Force Remote. The local call was rejected.`
				: `${providerLabel} hosted Web Search returned a local web_search function call, but Auto mode has no Dline local Web Search fallback for the current prompt profile. The local call was rejected.`
		const presentation: ClineSayTool = {
			tool: "webSearch",
			path: query,
			content: `Web search routing failed: ${message}`,
			operationIsLocatedInWorkspace: false,
			webSearch: {
				schemaVersion: 1,
				status: "failed",
				source: {
					id: `${providerId}-hosted`,
					label: `${providerLabel} Web Search`,
					execution: "hosted",
					provider: providerId,
				},
				query,
				error: message,
			},
		}
		await this.say("tool", JSON.stringify(presentation), undefined, undefined, false)
		return message
	}

	// Auto-approval methods using the AutoApprove class
	private shouldAutoApproveTool(toolName: ClineDefaultTool): boolean | [boolean, boolean] {
		return this.autoApprover.shouldAutoApproveTool(toolName)
	}

	private async shouldAutoApproveToolWithPath(
		blockname: ClineDefaultTool,
		autoApproveActionpath: string | undefined,
	): Promise<boolean> {
		return this.autoApprover.shouldAutoApproveToolWithPath(blockname, autoApproveActionpath)
	}

	/**
	 * Duration scope of the tool currently executing, when one is.
	 *
	 * Held on the executor rather than threaded through every handler so the
	 * approval and command wrappers can find it without changing the tool
	 * interface. It is saved and restored around each execution, so a tool that
	 * runs another one restores its parent's scope on the way out.
	 */
	private activeDurationScope: ToolDurationScope | undefined

	constructor(
		// Core Services & Managers
		private taskState: TaskState,
		private taskController: TaskController,
		private messageStateHandler: MessageStateHandler,
		private api: ApiHandler,
		private urlContentFetcher: UrlContentFetcher,
		private browserSession: BrowserSession,
		private diffViewProvider: DiffViewProvider,
		private mcpHub: McpHub,
		private fileContextTracker: FileContextTracker,
		private taskFileTracker: TaskFileTracker,
		private ignoreController: IgnoreController,
		private commandPermissionController: CommandPermissionController,
		private contextManager: ContextManager,
		private stateManager: StateManager,
		private getMode: () => Mode,
		private getTaskCapabilityToggles: () => TaskCapabilityToggles,
		private identityFactory: IdentityFactory,
		private activityStore: TaskActivityStore,
		private providerRequestRounds: ProviderRequestRoundPort | undefined,

		// Configuration & Settings

		private cwd: string,
		private taskId: string,
		private ulid: string,
		private vscodeTerminalExecutionMode: "vscodeTerminal" | "backgroundExec",

		// Workspace Management
		private workspaceManager: WorkspaceRootManager | undefined,
		private isMultiRootEnabled: boolean,
		private interactions: TaskInteractionPorts,
		private compactionAttemptGuard: CompactionAttemptGuard,

		// Callbacks to the Task (Entity)
		private say: (
			type: ClineSay,
			text?: string,
			images?: string[],
			files?: string[],
			partial?: boolean,
			existingTs?: number,
		) => Promise<number | undefined>,
		private ask: (
			type: ClineAsk,
			text?: string,
			partial?: boolean,
		) => Promise<{
			response: ClineAskResponse
			text?: string
			images?: string[]
			files?: string[]
		}>,
		private saveCheckpoint: (isAttemptCompletionMessage?: boolean, completionMessageTs?: number) => Promise<void>,
		private sayAndCreateMissingParamError: (
			toolName: ClineDefaultTool,
			paramName: string,
			relPath?: string,
			existingTs?: number,
		) => Promise<ToolResponse>,
		private executeCommandTool: (
			command: string,
			timeoutSeconds: number | undefined,
			options?: CommandExecutionOptions,
		) => Promise<CommandExecutionOutcome>,
		private killCommandTool: (functionId: string) => Promise<CommandCancellationResult>,
		private cancelRunningCommandTool: () => Promise<boolean>,
		private doesLatestTaskCompletionHaveNewChanges: () => Promise<boolean>,
		private updateFCListFromToolResponse: (taskProgress: string | undefined) => Promise<void>,
		private focusChainForceUpdate: (newPlan: string) => Promise<void>,
		private switchToActMode: () => Promise<boolean>,
		private cancelTask: () => Promise<void>,

		// Atomic hook state helpers from Task
		private setActiveHookExecution: (hookExecution: NonNullable<typeof taskState.activeHookExecution>) => Promise<void>,
		private clearActiveHookExecution: () => Promise<void>,
		private getActiveHookExecution: () => Promise<typeof taskState.activeHookExecution>,
		private runUserPromptSubmitHook: (
			userContent: ClineContent[],
			context: "initial_task" | "resume" | "feedback",
		) => Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }>,
		private updateClineMessage: (
			index: number,
			updates: { text?: string; exitCode?: number; commandStatus?: CommandStatus },
		) => Promise<void>,
	) {
		this.autoApprover = new AutoApprove(this.stateManager, this.taskId)
		this.imageGenerationService = createImageGenerationRuntime({
			taskId: this.taskId,
			ulid: this.ulid,
			stateManager: this.stateManager,
			getCurrentMode: this.getMode,
		}).service

		// Initialize the coordinator and register all tool handlers
		this.coordinator = new ToolExecutorCoordinator()
		this.registerToolHandlers()
	}

	// Create a properly typed TaskConfig object for handlers
	// NOTE: modifying this object in the tool handlers is okay since these are all references to the singular ToolExecutor instance's variables. However, be careful modifying this object assuming it will update the ToolExecutor instance, e.g. config.browserSession = ... will not update the ToolExecutor.browserSession instance variable. Use applyLatestBrowserSettings() instead.
	private asToolConfig(): TaskConfig {
		const webToolsEnabled = this.getWebToolsEnabledForExecution()
		const config: TaskConfig = {
			taskId: this.taskId,
			ulid: this.ulid,
			mode: this.getMode(),
			strictPlanModeEnabled: this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			doubleCheckCompletionEnabled: this.stateManager.getGlobalSettingsKey("doubleCheckCompletionEnabled"),
			vscodeTerminalExecutionMode: this.vscodeTerminalExecutionMode,
			enableParallelToolCalling: this.isParallelToolCallingEnabled(),
			isSubagentExecution: false,
			webToolsEnabled,
			subagentsEnabled: this.promptRuntime?.subagentsEnabled,
			webSearchRoutingPlan: this.getWebSearchRoutingPlanForExecution(webToolsEnabled),
			explicitInstructions: this.explicitInstructions,
			cwd: this.cwd,
			workspaceManager: this.workspaceManager,
			isMultiRootEnabled: this.isMultiRootEnabled,
			taskState: this.taskState,
			taskController: this.taskController,
			messageState: this.messageStateHandler,
			api: this.api,
			autoApprovalSettings: this.stateManager.getGlobalSettingsKey("autoApprovalSettings"),
			autoApprover: this.autoApprover,
			browserSettings: this.promptRuntime
				? {
						...this.stateManager.getGlobalSettingsKey("browserSettings"),
						disableToolUse: !this.promptRuntime.browserEnabled,
						viewport: this.promptRuntime.browserViewport,
					}
				: this.stateManager.getGlobalSettingsKey("browserSettings"),
			focusChainSettings: {
				...this.stateManager.getGlobalSettingsKey("focusChainSettings"),
				enabled: this.getFocusChainEnabledForExecution(),
			},
			capabilityToggles: this.promptRuntime?.capabilityToggles ?? this.getTaskCapabilityToggles(),
			interactions: this.interactions,
			compactionAttemptGuard: this.compactionAttemptGuard,
			services: {
				mcpHub: this.mcpHub,
				browserSession: this.browserSession,
				urlContentFetcher: this.urlContentFetcher,
				diffViewProvider: this.diffViewProvider,
				fileContextTracker: this.fileContextTracker,
				taskFileTracker: this.taskFileTracker,
				ignoreController: this.ignoreController,
				commandPermissionController: this.commandPermissionController,
				contextManager: this.contextManager,
				stateManager: this.stateManager,
				imageGenerationService: this.imageGenerationService,
			},
			callbacks: {
				focusChainForceUpdate: this.focusChainForceUpdate.bind(this),
				say: this.say,
				// Waiting for the user is not work the tool performed, so the
				// wrapper is installed once here instead of asking every handler
				// to remember to exclude its own approval.
				ask: (...args: Parameters<typeof this.ask>) =>
					this.activeDurationScope
						? this.activeDurationScope.excludeWait("approval", () => this.ask(...args))
						: this.ask(...args),
				saveCheckpoint: this.saveCheckpoint,
				postStateToWebview: async () => {},
				reinitExistingTaskFromId: async () => {},
				cancelTask: () => this.requestCancellationFromToolEffect(),
				updateTaskHistory: async () => [],
				// A command's runtime belongs to the workspace, not to Dline.
				executeCommandTool: (...args: Parameters<typeof this.executeCommandTool>) =>
					this.activeDurationScope
						? this.activeDurationScope.excludeWait("command", () => this.executeCommandTool(...args))
						: this.executeCommandTool(...args),
				killCommandTool: this.killCommandTool,
				cancelRunningCommandTool: this.cancelRunningCommandTool,
				doesLatestTaskCompletionHaveNewChanges: this.doesLatestTaskCompletionHaveNewChanges,
				updateFCListFromToolResponse: this.updateFCListFromToolResponse,
				sayAndCreateMissingParamError: this.sayAndCreateMissingParamError,
				shouldAutoApproveTool: this.shouldAutoApproveTool.bind(this),
				shouldAutoApproveToolWithPath: this.shouldAutoApproveToolWithPath.bind(this),
				applyLatestBrowserSettings: this.applyLatestBrowserSettings.bind(this),
				switchToActMode: this.switchToActMode,
				setActiveHookExecution: this.setActiveHookExecution,
				clearActiveHookExecution: this.clearActiveHookExecution,
				getActiveHookExecution: this.getActiveHookExecution,
				runUserPromptSubmitHook: this.runUserPromptSubmitHook,
				updateClineMessage: this.updateClineMessage,
			},
			coordinator: this.coordinator,
			identityFactory: this.identityFactory,
			activityStore: this.activityStore,
			providerRequestRounds: this.providerRequestRounds,
			controllerContext: this._controllerContext,
			subagentJobManager: this.subagentJobManager,
		}

		// Validate the config at runtime to catch any missing properties
		validateTaskConfig(config)
		return config
	}

	/** Submit cancellation without making the current EXECUTE_TOOL effect wait for its own drain. */
	private requestCancellationFromToolEffect(): Promise<void> {
		queueMicrotask(() => {
			void this.cancelTask().catch((error: unknown) => {
				Logger.error("[ToolExecutor] Tool hook cancellation failed:", error)
			})
		})
		return Promise.resolve()
	}

	/**
	 * Register all tool handlers with the coordinator
	 */
	private registerToolHandlers(): void {
		const validator = new ToolValidator(this.ignoreController)
		// Register all tools via toolUseNames
		for (const tool of toolUseNames) {
			this.coordinator.registerByName(tool, validator)
		}
	}

	/**
	 * Main entry point for tool execution - called by Task class
	 */
	public async executeTool(block: ToolUse): Promise<void> {
		const span = startSignalSpan({
			name: "tool.execution",
			attributes: {
				tool: block.name,
				task_id: this.taskId,
				is_native: block.isNativeToolCall === true,
				is_partial: block.partial === true,
			},
		})
		// The span already records this boundary, but only as a trace. A metric
		// is what makes a tool that became slow queryable and alertable, and the
		// duration it reports has to exclude the waits the user and the
		// workspace own or it would measure them instead.
		const scope = new ToolDurationScope()
		const previousScope = this.activeDurationScope
		this.activeDurationScope = scope
		// Partial blocks are streamed presentation updates of a call that has not
		// finished arriving, so measuring them would flood the histogram with
		// fragments of one execution.
		const shouldReport = block.partial !== true
		try {
			const handled = await runWithSignalSpan(span, () => this.execute(block))
			span.setAttribute("handled", handled)
			span.end(handled ? "success" : "failure")
			if (shouldReport) this.reportToolDuration(scope, block, handled ? "success" : "failure")
		} catch (error) {
			span.recordException(error)
			span.end("failure")
			if (shouldReport) this.reportToolDuration(scope, block, "failure")
			throw error
		} finally {
			this.activeDurationScope = previousScope
		}
	}

	/**
	 * Report how long this tool spent working, apart from what it waited on.
	 *
	 * The waits are reported as their own dimensions rather than dropped: a call
	 * whose active time is small but whose approval wait is long is a different
	 * situation from a fast call, and only the split makes that visible.
	 */
	private reportToolDuration(scope: ToolDurationScope, block: ToolUse, outcome: "success" | "failure"): void {
		const totals = scope.read()
		// Only bounded dimensions are passed: every entry here becomes a metric
		// label, so a per-call millisecond value would make almost every
		// execution its own time series. Whether the call waited at all is the
		// part worth querying; the exact waits stay on the performance event,
		// which is not turned into labels.
		recordPerfPhase(PerfDomain.Tool, "execution", totals.activeMs, {
			tool: block.name,
			outcome,
			is_native: block.isNativeToolCall === true,
			waited_for_approval: totals.approvalWaitMs > 0,
			waited_for_command: totals.commandWaitMs > 0,
		})
	}

	/** Consume one directive only after the owning runtime block has committed completion. */
	public takePostCommitDirective(dlineTid: string): ToolPostCommitDirective | undefined {
		const directive = this.postCommitDirectives.get(dlineTid)
		this.postCommitDirectives.delete(dlineTid)
		return directive
	}

	/** Consume a restored turn-end response through the original handler's post-response path. */
	public async continueTurnEndInteraction(
		kind: InteractionKind,
		block: ToolUse,
		outcome: InteractionOutcome,
	): Promise<ToolResponse> {
		if (!requiresTurnEndContinuation(kind)) {
			throw new Error(`Interaction kind '${kind}' has no turn-end continuation.`)
		}
		const handler = this.coordinator.getHandler(block.name)
		if (!handler || !isTurnEndContinuationHandler(handler)) {
			throw new Error(`Tool '${block.name}' does not implement its turn-end continuation.`)
		}
		return handler.continueInteraction(this.asToolConfig(), block, outcome)
	}

	/** Commit a restored handler result to both the next API turn and the durable UI result ledger. */
	public async commitRestoredToolResult(content: ToolResponse, block: ToolUse): Promise<void> {
		await this.commitToolResult(content, block)
	}

	/** Close an interrupted tool pairing without replaying an unknown side effect. */
	public async commitInterruptedToolResult(block: ToolUse, reason: string): Promise<void> {
		await this.commitToolResult(formatResponse.toolError(reason), block, true)
	}

	/**
	 * Updates the browser settings
	 */
	public async applyLatestBrowserSettings() {
		await this.browserSession.dispose()
		const apiHandlerModel = this.api.getModel()
		const useWebp = this.api ? !modelDoesntSupportWebp(apiHandlerModel) : true
		const browserSettings = this.promptRuntime
			? {
					...this.stateManager.getGlobalSettingsKey("browserSettings"),
					disableToolUse: !this.promptRuntime.browserEnabled,
					viewport: this.promptRuntime.browserViewport,
				}
			: undefined
		this.browserSession = new BrowserSession(this.stateManager, useWebp, browserSettings)
		return this.browserSession
	}

	/**
	 * Handles errors during tool execution.
	 *
	 * Logs the error, displays it to the user via the UI, and adds an error
	 * result to the conversation context so the AI can see what went wrong.
	 *
	 * @param action Description of what was being attempted (e.g., "executing read_file")
	 * @param error The error that occurred
	 * @param block The tool use block that caused the error
	 */
	private async handleError(action: string, error: Error, block: ToolUse): Promise<void> {
		const errorString = `Error ${action}: ${error.message}`
		await this.say("error", errorString)

		// Create error response for the tool
		const errorResponse = formatResponse.toolError(errorString)
		await this.commitToolResult(errorResponse, block, true)
	}

	/**
	 * Pushes a tool result to the user message content.
	 *
	 * This is a critical method that:
	 * - Formats the tool result appropriately for the API
	 * - Adds it to the conversation context
	 * - Marks that a tool has been used in this turn
	 *
	 * @param content The tool response content to add
	 * @param block The tool use block that generated this result
	 */
	private pushToolResult = (content: ToolResponse, block: ToolUse, isError?: boolean) => {
		// Use the ToolResultUtils to properly format and push the tool result
		const result = ToolResultUtils.pushToolResult(
			content,
			block,
			this.taskState.userMessageContent,
			(block: ToolUse) => ToolDisplayUtils.getToolDescription(block),
			this.coordinator,
			isError,
		)

		// Mark that a tool has been used (only matters when parallel tool calling is disabled)
		if (!this.isParallelToolCallingEnabled()) {
			this.taskState.didAlreadyUseTool = true
		}
		return result
	}

	/** Commit one canonical result to both pending API content and durable storage. */
	private async commitToolResult(content: ToolResponse, block: ToolUse, isError?: boolean): Promise<void> {
		const result = this.pushToolResult(content, block, isError)
		await this.recordPartialToolResult(result)
	}

	// Record a partial_tool_result for resume. Must be awaited so the
	// webview message order is deterministic — fire-and-forget would let
	// auto-approved tool results race ahead of a subsequent ask.
	private async recordPartialToolResult(result: ClineUserToolResultContentBlock): Promise<void> {
		// Storage + push handled by say(), gated by TaskController.send()
		await this.say("partial_tool_result", serializeDurableToolResult(result))
	}

	/**
	 * Check if parallel tool calling is enabled.
	 * Parallel tool calling is enabled if:
	 * 1. User has enabled it in settings, OR
	 * 2. The current model/provider supports native tool calling and handles parallel tools well
	 */
	private isParallelToolCallingEnabled(): boolean {
		if (this.promptRuntime) return this.promptRuntime.parallelToolsEnabled
		const enableParallelSetting = this.stateManager.getGlobalSettingsKey("enableParallelToolCalling")
		const model = this.api.getModel()
		const apiConfig = this.stateManager.getApiConfiguration()
		const mode = this.getMode()
		const currentProfile = mode === "plan" ? apiConfig.planModeProfile : apiConfig.actModeProfile
		const providerId = resolveProviderFromProfile(currentProfile) || DEFAULT_API_PROVIDER
		return isParallelToolCallingEnabled(enableParallelSetting, { providerId, model, mode })
	}

	/**
	 * Tools that are restricted in plan mode and can only be used in act mode
	 */
	private static readonly PLAN_MODE_RESTRICTED_TOOLS: ClineDefaultTool[] = [
		ClineDefaultTool.FILE_NEW,
		ClineDefaultTool.FILE_EDIT,
		ClineDefaultTool.NEW_RULE,
		ClineDefaultTool.APPLY_PATCH,
	]

	/**
	 * Execute a tool through the coordinator if it's registered.
	 *
	 * This is the main entry point for tool execution, called by the Task class.
	 * It handles:
	 * - Checking if the tool is registered with the coordinator
	 * - Validating tool execution is allowed (not rejected, not already used, etc.)
	 * - Enforcing plan mode restrictions on file modification tools
	 * - Delegating to partial or complete block handlers
	 * - Error handling and checkpointing
	 *
	 * @param block The tool use block to execute
	 * @returns true if the tool was handled (even if execution failed), false if not registered
	 */
	private async execute(block: ToolUse, config: TaskConfig = this.asToolConfig()): Promise<boolean> {
		canonicalizeAttemptCompletionParams(block)

		try {
			if (block.isNativeToolCall && isInternalNativeToolName(block.name)) {
				if (!block.partial) {
					const taskProgress = block.params?.task_progress
					const focusChainEnabled = this.getFocusChainEnabledForExecution()
					const hasTodoUpdate = focusChainEnabled && typeof taskProgress === "string" && hasValidTodoItem(taskProgress)
					if (hasTodoUpdate) {
						await this.updateFCListFromToolResponse(taskProgress)
					}
					await this.commitToolResult(
						hasTodoUpdate
							? "TODO list update accepted."
							: "No TODO list update provided; current TODO list unchanged.",
						block,
					)
				}
				return true
			}

			if (block.isNativeToolCall && !isExplicitOnlyTool(block.name) && !this.isNativeToolAdmitted(block.name)) {
				if (block.name === ClineDefaultTool.WEB_SEARCH && config.webSearchRoutingPlan?.route === "hosted") {
					if (block.partial) return true
					const fallback = this.canFallbackUnadvertisedWebSearch(config)
					const message = await this.presentUnadvertisedHostedWebSearch(
						block,
						fallback,
						config.webSearchRoutingPlan.mode,
					)
					if (fallback) {
						config = this.createLocalWebSearchFallbackConfig(config)
					} else {
						await this.commitToolResult(formatResponse.toolError(message), block, true)
						return true
					}
				} else {
					if (!block.partial) {
						const message = `Native tool '${block.name}' was not available in this API request. The call was ignored.`
						await this.commitToolResult(formatResponse.toolError(message), block, true)
					}
					return true
				}
			}

			if (!this.coordinator.has(block.name)) {
				if (block.isNativeToolCall && !block.partial) {
					const message = `Native tool '${block.name}' has no registered handler. The call was ignored.`
					await this.commitToolResult(formatResponse.toolError(message), block, true)
					return true
				}
				return false
			}

			// Check if user rejected a previous tool
			if (this.taskController.wasRejected(block.dline_tid || "")) {
				const reason = block.partial
					? "Tool was interrupted and not executed due to user rejecting a previous tool."
					: "Skipping tool due to user rejecting a previous tool."
				const message = `${reason} ${ToolDisplayUtils.getToolDescription(block, this.coordinator)}`
				if (!(await this.pushSkippedNativeToolResult(block, message))) {
					this.createToolRejectionMessage(block, reason)
				}
				return true
			}

			// Check if a tool has already been used in this message (only enforced when parallel tool calling is disabled)
			if (!this.isParallelToolCallingEnabled() && this.taskState.didAlreadyUseTool && !isTurnEndingToolName(block.name)) {
				const message = formatResponse.toolAlreadyUsed(block.name)
				if (!(await this.pushSkippedNativeToolResult(block, message))) {
					this.taskState.userMessageContent.push({
						type: "text",
						text: message,
					})
				}
				return true
			}

			// Logic for plan-mode tool call restrictions
			if (
				this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled") &&
				this.getMode() === "plan" &&
				block.name &&
				this.isPlanModeToolRestricted(block.name)
			) {
				const errorMessage = `Tool '${block.name}' is not available in PLAN MODE. This tool is restricted to ACT MODE for file modifications. Only use tools available for PLAN MODE when in that mode.`
				await this.say("error", errorMessage)
				// Only push the final error message when the streaming is done.
				if (!block.partial) {
					await this.commitToolResult(formatResponse.toolError(errorMessage), block, true)
				}
				return true
			}

			// Close browser for non-browser tools
			if (block.name !== "browser_action") {
				await this.browserSession.closeBrowser()
			}

			// Explicit-only tools must hold pending authority before any partial UI is rendered.
			if (block.partial) {
				if (!this.canRenderExplicitTool(block.name)) return true
				// A block that already owns an approval interaction keeps its durable ask
				// anchor; a late partial frame must not rewrite that row.
				if (this.isAwaitingApprovalBlock(block)) return true
				await this.handlePartialBlock(block, config)
				return true
			}

			const explicitAuthorization = authorizeExplicitToolExecution(block.name, config.explicitInstructions)
			if (!explicitAuthorization.ok) {
				const message = `Explicit-only tool '${block.name}' was rejected: ${explicitAuthorization.code}.`
				await this.commitToolResult(formatResponse.toolError(message), block, true)
				return true
			}
			if (explicitAuthorization.authorization) {
				config = { ...config, explicitInstructionAuthorization: explicitAuthorization.authorization }
			}

			// Handle complete blocks
			await this.handleCompleteBlock(block, config)
			return true
		} catch (error) {
			if (this.taskState.abort || isInteractionCancellationError(error)) {
				return true
			}
			await this.handleError(`executing ${block.name}`, error as Error, block)
			return true
		}
	}

	/**
	 * Check if a tool is restricted in plan mode.
	 *
	 * In strict plan mode, file modification tools (write_to_file, editedExistingFile, etc.)
	 * are blocked. The AI must switch to Act mode to use these tools.
	 *
	 * @param toolName The name of the tool to check
	 * @returns true if the tool is restricted in plan mode, false otherwise
	 */
	private isPlanModeToolRestricted(toolName: ClineDefaultTool): boolean {
		return ToolExecutor.PLAN_MODE_RESTRICTED_TOOLS.includes(toolName)
	}

	/**
	 * Create a tool rejection message and add it to user message content.
	 *
	 * Used when a tool cannot be executed (e.g., user rejected a previous tool,
	 * tool was interrupted, etc.). Adds a text message to the conversation explaining
	 * why the tool was not executed.
	 *
	 * @param block The tool use block that was rejected
	 * @param reason Human-readable explanation of why the tool was rejected
	 */
	private createToolRejectionMessage(block: ToolUse, reason: string): void {
		this.taskState.userMessageContent.push({
			type: "text",
			text: `${reason} ${ToolDisplayUtils.getToolDescription(block, this.coordinator)}`,
		})
	}

	private async pushSkippedNativeToolResult(block: ToolUse, message: string): Promise<boolean> {
		if (block.partial || !block.isNativeToolCall) {
			return false
		}

		await this.commitToolResult(formatResponse.toolError(message), block, true)
		return true
	}

	/**
	 * Adds hook context modification to the conversation if provided.
	 * Parses the context to extract type prefix and formats as XML.
	 *
	 * @param contextModification The context string from the hook output
	 * @param source The hook source name ("PreToolUse" or "PostToolUse")
	 */
	private addHookContextToConversation(contextModification: string | undefined, source: string): void {
		if (!contextModification) {
			return
		}

		const contextText = contextModification.trim()
		if (!contextText) {
			return
		}

		// Extract context type from first line if specified (e.g., "WORKSPACE_RULES: ...")
		const lines = contextText.split("\n")
		const firstLine = lines[0]
		let contextType = "general"
		let content = contextText

		// Check if first line specifies a type: "TYPE: content"
		const typeMatchRegex = /^([A-Z_]+):\s*(.*)/
		const typeMatch = typeMatchRegex.exec(firstLine)
		if (typeMatch) {
			contextType = typeMatch[1].toLowerCase()
			const remainingLines = lines.slice(1).filter((l: string) => l.trim())
			content = typeMatch[2] ? [typeMatch[2], ...remainingLines].join("\n") : remainingLines.join("\n")
		}

		const hookContextBlock = {
			type: "text" as const,
			text: `<hook_context source="${source}" type="${contextType}">\n${content}\n</hook_context>`,
		}

		this.taskState.userMessageContent.push(hookContextBlock)
	}

	/**
	 * Runs the PostToolUse hook after tool execution.
	 * This is extracted from handleCompleteBlock to eliminate code duplication
	 * between success and error paths.
	 *
	 * @param block The tool use block that was executed
	 * @param toolResult The result from the tool execution
	 * @param executionSuccess Whether the tool executed successfully
	 * @param executionStartTime The timestamp when tool execution started
	 * @returns true if hook requested cancellation, false otherwise
	 */
	private async runPostToolUseHook(
		block: ToolUse,
		toolResult: ToolResponse,
		executionSuccess: boolean,
		executionStartTime: number,
		hooksEnabled: boolean,
	): Promise<boolean> {
		const { executeHook } = await import("../hooks/hook-executor")

		const executionTimeMs = Date.now() - executionStartTime

		const postToolResult = await executeHook({
			hookName: "PostToolUse",
			hookInput: {
				postToolUse: {
					toolName: block.name,
					parameters: block.params,
					result: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
					success: executionSuccess,
					executionTimeMs,
				},
			},
			isCancellable: true,
			say: this.say,
			setActiveHookExecution: this.setActiveHookExecution,
			clearActiveHookExecution: this.clearActiveHookExecution,
			messageStateHandler: this.messageStateHandler,
			taskId: this.taskId,
			hooksEnabled,
			model: getHookModelContext(this.api, this.stateManager),
			toolName: block.name,
		})

		// Handle cancellation request
		if (postToolResult.cancel === true) {
			const errorMessage = postToolResult.errorMessage || "Hook requested task cancellation"
			await this.say("error", errorMessage)
			return true
		}

		// Add context modification to the conversation if provided
		if (postToolResult.contextModification) {
			this.addHookContextToConversation(postToolResult.contextModification, "PostToolUse")
		}

		return false
	}

	/**
	 * Handle partial block streaming UI updates.
	 *
	 * During streaming API responses, the AI sends partial tool use blocks as they're
	 * generated. This method updates the UI to show the tool being constructed in real-time.
	 *
	 * NOTE: This is ONLY for UI updates. No tool results are pushed to the conversation
	 * during partial block handling. The complete block handler will add the final result.
	 *
	 * @param block The partial tool use block with incomplete parameters
	 * @param config The task configuration containing all necessary context
	 */
	private async handlePartialBlock(block: ToolUse, config: TaskConfig): Promise<void> {
		// NOTE: We don't push tool results in partial blocks because this is only for UI streaming.
		// The ToolExecutor will handle pushToolResult() when the complete block is processed.
		// This maintains separation of concerns: partial = UI updates, complete = final state changes.
		const handler = this.coordinator.getHandler(block.name)

		// Check if handler supports partial blocks with proper typing
		if (handler && "handlePartialBlock" in handler) {
			const uiHelpers = createUIHelpers(config)
			const partialHandler = handler as IPartialBlockHandler
			await partialHandler.handlePartialBlock(block, uiHelpers)
		}
	}

	/**
	 * Handle complete block execution.
	 *
	 * This is the main execution flow for a tool:
	 * 1. Execute the actual tool (tool handlers now run PreToolUse hooks post-approval)
	 * 2. Run PostToolUse hooks (if enabled) - cannot block, only observe
	 * 3. Add hook context modifications to the conversation
	 * 4. Update focus chain tracking
	 *
	 * Note: PreToolUse hooks are now executed by individual tool handlers after approval
	 * and before the actual tool operation. This provides better UX as approval dialogs
	 * appear immediately without hook execution delay.
	 *
	 * PostToolUse hooks are for observation/logging only and cannot block.
	 *
	 * @param block The complete tool use block with all parameters
	 * @param config The task configuration containing all necessary context
	 */

	/**
	 * Re-render a partial tool block through the UI helpers.
	 * Used when the stream identity of a partial block changes (e.g. stable block index).
	 *
	 * @param block The tool use block to re-render. Must be partial.
	 */
	public async reRenderPartialBlock(block: ToolUse, _existingTs?: number): Promise<void> {
		if (this.taskState.abort || this.taskController.wasRejected(block.dline_tid || "")) return
		if (!block.partial) return
		// Once a block owns an approval interaction, its ask row is the durable
		// causal anchor the Webview matches against. A partial re-render would
		// rewrite that same ts as an unfinished row and drop the interactionId,
		// leaving the approval controls unreachable while the handler still waits.
		if (this.isAwaitingApprovalBlock(block)) return
		if (!this.canRenderExplicitTool(block.name)) return
		if (!this.coordinator.has(block.name)) return
		const handler = this.coordinator.getHandler(block.name)
		if (!handler || !("handlePartialBlock" in handler)) return
		try {
			const config = this.asToolConfig()
			const uiHelpers = createUIHelpers(config)
			await (handler as IPartialBlockHandler).handlePartialBlock(block, uiHelpers)
		} catch (error) {
			Logger.error(`[reRenderPartialBlock] ${block.name}:`, error)
		}
	}

	/** Return whether this block currently owns an approval interaction that must keep its durable anchor. */
	private isAwaitingApprovalBlock(block: ToolUse): boolean {
		const dlineTid = block.dline_tid
		if (!dlineTid) return false
		return this.taskController.getPhase(dlineTid) === BlockPhase.AWAITING_APPROVAL
	}
	private async handleCompleteBlock(block: ToolUse, config: TaskConfig): Promise<void> {
		// Check abort flag at the very start to prevent execution after cancellation
		if (this.taskState.abort) {
			return
		}

		const hooksEnabled = getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled"))

		// Track if we need to cancel after hooks complete
		let shouldCancelAfterHook = false

		let executionSuccess = true
		let toolResult: ToolResponse = ""
		let postCommitDirective: ToolPostCommitDirective | undefined
		let toolWasExecuted = false
		const executionStartTime = Date.now()

		try {
			// Final abort check immediately before tool execution
			if (this.taskState.abort) {
				return
			}

			// Block attempt_completion when focus chain is incomplete (other turn-ending tools remain available)
			const focusChainEnabled = this.getFocusChainEnabledForExecution()
			const fcChecklist = this.taskState.currentFocusChainChecklist
			if (
				block.name === ClineDefaultTool.ATTEMPT &&
				focusChainEnabled &&
				fcChecklist &&
				!isAllItemsCompleted(fcChecklist)
			) {
				const { getPrompt } = await import("../prompts/i18n")
				const blockMsg = getPrompt("focusChain", "attemptCompletionBlocked")
				const fullMsg = `${blockMsg}\n\nCurrent checklist:\n${fcChecklist}`
				toolResult = formatResponse.toolError(fullMsg)
				toolWasExecuted = true
				this.taskState.consecutiveMistakeCount++
			} else {
				// Execute the actual tool
				const executionResult = normalizeToolExecutionResult(await this.coordinator.execute(config, block))
				toolResult = executionResult.response
				postCommitDirective = executionResult.postCommit
			}
			toolWasExecuted = true
			if (toolResult !== NO_TOOL_RESULT) {
				await this.commitToolResult(toolResult, block)
			}

			// --- Repeated tool call loop detection ---
			// Must run BEFORE updating lastToolName/lastToolParams so we compare
			// against the previous call's values, not the current one.
			const currentSignature = toolCallSignature(block.params)
			const loopCheck = checkRepeatedToolCall(this.taskState, block.name, currentSignature)

			if (loopCheck.softWarning) {
				this.taskState.userMessageContent.push({
					type: "text",
					text: formatResponse.repeatedToolCall(block.name, LOOP_DETECTION_SOFT_THRESHOLD),
				})
			}

			if (loopCheck.hardEscalation) {
				this.taskState.consecutiveMistakeCount = this.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes")
			}

			// Update state AFTER comparison
			this.taskState.lastToolName = block.name
			this.taskState.lastToolParams = currentSignature

			// Check abort before running PostToolUse hook (success path)
			if (this.taskState.abort) {
				return
			}

			// Run PostToolUse hook for successful tool execution
			// Skip for attempt_completion since it marks task completion, not actual work
			if (hooksEnabled && block.name !== "attempt_completion") {
				const hookRequestedCancel = await this.runPostToolUseHook(
					block,
					toolResult,
					executionSuccess,
					executionStartTime,
					hooksEnabled, // always true here - already checked by caller
				)
				if (hookRequestedCancel) {
					void config.callbacks.cancelTask().catch((error: unknown) => {
						Logger.error("[ToolExecutor] PostToolUse cancellation failed:", error)
					})
					shouldCancelAfterHook = true
				}
			}
		} catch (error) {
			executionSuccess = false
			toolResult = formatResponse.toolError(`Tool execution failed: ${error}`)

			// Check abort before running PostToolUse hook (error path)
			if (this.taskState.abort) {
				throw error
			}

			// Run PostToolUse hook for failed tool execution
			// Skip for attempt_completion since it marks task completion, not actual work
			if (toolWasExecuted && hooksEnabled && block.name !== "attempt_completion") {
				const hookRequestedCancel = await this.runPostToolUseHook(
					block,
					toolResult,
					executionSuccess,
					executionStartTime,
					hooksEnabled, // always true here - already checked by caller
				)
				if (hookRequestedCancel) {
					void config.callbacks.cancelTask().catch((cancelError: unknown) => {
						Logger.error("[ToolExecutor] PostToolUse cancellation failed:", cancelError)
					})
					shouldCancelAfterHook = true
				}
			}

			// Re-throw the error after PostToolUse completes
			throw error
		}

		// Early return if hook requested cancellation
		if (shouldCancelAfterHook) {
			return
		}

		// Apply one valid TODO update after the owning tool completes.
		const taskProgress = block.params.task_progress
		if (
			!block.partial &&
			this.getFocusChainEnabledForExecution() &&
			typeof taskProgress === "string" &&
			hasValidTodoItem(taskProgress)
		) {
			await this.updateFCListFromToolResponse(taskProgress)
		}
		if (postCommitDirective) {
			if (this.postCommitDirectives.has(block.dline_tid)) {
				throw new Error(`Post-commit directive already exists for dlineTid=${block.dline_tid}`)
			}
			this.postCommitDirectives.set(block.dline_tid, postCommitDirective)
		}
	}
}
