import type { ApiHandler } from "@core/api"
import type { WebSearchRoutingPlan } from "@core/api/server-tools"
import type { IdentityFactory } from "@core/api/transform/block-identity"
import type { CompactionPassIdentity } from "@core/context/context-management/target-window-fitting"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import type { ImageGenerationService } from "@core/image-generation/ImageGenerationService"
import type { CommandPermissionController } from "@core/permissions"
import type { ExplicitInstructionAuthorization, ExplicitInstructionConsumePort } from "@core/task/explicit-instructions/types"
import type { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { CommandCancellationResult, CommandExecutionOptions, CommandExecutionOutcome } from "@integrations/terminal"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import type { McpHub } from "@services/mcp/McpHub"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { BrowserSettings } from "@shared/BrowserSettings"
import type { ClineExtensionContext } from "@shared/cline/context"
import type { ClineAsk, ClineSay, CommandStatus } from "@shared/ExtensionMessage"
import type { FocusChainSettings } from "@shared/FocusChainSettings"
import type { ClineContent, ClineToolResponseContent } from "@shared/messages/content"
import type { Mode } from "@shared/storage/types"
import type { TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import type { ClineDefaultTool } from "@shared/tools"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import { WorkspaceRootManager } from "@/core/workspace"
import type { ContextManager } from "../../../context/context-management/ContextManager"
import type { StateManager } from "../../../storage/StateManager"
import type { TaskActivityStore } from "../../activity/TaskActivityStore"
import type {
	CompleteInteractionRequest,
	InteractionOutcome,
	OpenInteractionRequest,
} from "../../interaction/InteractionCoordinator"
import type { MessageStateHandler } from "../../message-state"
import type { ProviderRequestRoundPort } from "../../performance/provider-request-round-port"
import type { TaskController } from "../../TaskController"
import type { TaskState } from "../../TaskState"
import type { AutoApprove } from "../../tools/autoApprove"
import type { HookExecution } from "../../types/HookExecution"
import type { SubagentJobManager } from "../subagent/SubagentJobManager"
import type { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { TASK_CALLBACKS_KEYS, TASK_CONFIG_KEYS, TASK_SERVICES_KEYS } from "../utils/ToolConstants"

/**
 * Strongly-typed configuration object passed to tool handlers
 */
/** Presentation-only request issued by one handler. */
export interface SayPresentationRequest {
	taskSay: ClineSay
	presentation?: string
	images?: string[]
	files?: string[]
	existingTs?: number
}

/** Interaction and presentation boundary exposed to handlers. */
export interface TaskInteractionPorts {
	open(request: OpenInteractionRequest): Promise<InteractionOutcome>
	complete(request: CompleteInteractionRequest): Promise<InteractionOutcome>
	say(request: SayPresentationRequest): Promise<void>
}

export interface CompactionAttemptGuard {
	isCurrent(passIdentity: CompactionPassIdentity, authorizationAttemptId: string): boolean
}

export interface TaskConfig {
	// Core identifiers
	taskId: string
	ulid: string
	cwd: string
	mode: Mode
	strictPlanModeEnabled: boolean
	yoloModeToggled: boolean
	doubleCheckCompletionEnabled: boolean
	vscodeTerminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	enableParallelToolCalling: boolean
	isSubagentExecution: boolean
	/** Request-frozen global Web Tools switch. */
	webToolsEnabled?: boolean
	/** Request-frozen Standard subagent feature gate. */
	subagentsEnabled?: boolean
	/** Request-frozen route used to admit or reject local Web Search execution. */
	webSearchRoutingPlan?: WebSearchRoutingPlan
	/** Request-scoped one-shot authority for explicit-only tools. */
	explicitInstructions?: ExplicitInstructionConsumePort
	/** Authorization consumed by the central gate for the current complete handler invocation. */
	explicitInstructionAuthorization?: ExplicitInstructionAuthorization
	/** Read-only identity gate for accepting one hidden fitting Pass result. */
	compactionAttemptGuard?: CompactionAttemptGuard

	// Multi-workspace support (optional for backward compatibility)
	workspaceManager?: WorkspaceRootManager
	isMultiRootEnabled?: boolean

	// State management
	taskState: TaskState
	taskController: TaskController
	messageState: MessageStateHandler

	// API and services
	api: ApiHandler
	services: TaskServices

	// Settings
	autoApprovalSettings: AutoApprovalSettings
	autoApprover: AutoApprove
	browserSettings: BrowserSettings
	focusChainSettings: FocusChainSettings
	capabilityToggles: TaskCapabilityToggles

	// Typed interaction boundary
	interactions: TaskInteractionPorts

	// Callbacks (strongly typed)
	callbacks: TaskCallbacks

	// Tool coordination
	coordinator: ToolExecutorCoordinator
	/** Task-local allocator for result item identities. */
	identityFactory: IdentityFactory
	/** Task-local real-time activity state shared by chat and the Activity view. */
	activityStore?: TaskActivityStore
	/** Task-owned Provider round admission for nested compaction and subagent requests. */
	providerRequestRounds?: ProviderRequestRoundPort

	/** VSCode extension context, required by spawn_task to create new webview panels. */
	controllerContext?: ClineExtensionContext

	/** Task-local background subagent job manager. */
	subagentJobManager?: SubagentJobManager
}

/**
 * All services available to tool handlers
 */
export interface TaskServices {
	mcpHub: McpHub
	browserSession: BrowserSession
	urlContentFetcher: UrlContentFetcher
	diffViewProvider: DiffViewProvider
	fileContextTracker: FileContextTracker
	taskFileTracker: TaskFileTracker
	ignoreController: IgnoreController
	commandPermissionController: CommandPermissionController
	contextManager: ContextManager
	stateManager: StateManager
	imageGenerationService: ImageGenerationService
}

/**
 * All callback functions available to tool handlers
 */
export interface TaskCallbacks {
	say: (
		type: ClineSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
		existingTs?: number,
	) => Promise<number | undefined>

	focusChainForceUpdate: (newPlan: string) => Promise<void>

	ask: (
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		options?: {
			existingTs?: number
			onTsCreated?: (ts: number) => void
		},
	) => Promise<{
		response: ClineAskResponse
		text?: string
		images?: string[]
		files?: string[]
	}>

	saveCheckpoint: (isAttemptCompletionMessage?: boolean, completionMessageTs?: number) => Promise<void>

	sayAndCreateMissingParamError: (
		toolName: ClineDefaultTool,
		paramName: string,
		relPath?: string,
		existingTs?: number,
	) => Promise<ClineToolResponseContent>

	executeCommandTool: (
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	) => Promise<CommandExecutionOutcome>
	killCommandTool?: (functionId: string) => Promise<CommandCancellationResult>
	cancelRunningCommandTool?: () => Promise<boolean>

	doesLatestTaskCompletionHaveNewChanges: () => Promise<boolean>

	updateFCListFromToolResponse: (taskProgress: string | undefined) => Promise<void>

	shouldAutoApproveTool: (toolName: ClineDefaultTool) => boolean | [boolean, boolean]
	shouldAutoApproveToolWithPath: (toolName: ClineDefaultTool, path?: string) => Promise<boolean>

	// Additional callbacks for task management
	postStateToWebview: () => Promise<void>
	reinitExistingTaskFromId: (taskId: string) => Promise<void>
	cancelTask: () => Promise<void>
	updateTaskHistory: (update: unknown) => Promise<unknown[]>

	applyLatestBrowserSettings: () => Promise<BrowserSession>

	switchToActMode: () => Promise<boolean>

	// Hook execution callbacks
	setActiveHookExecution: (hookExecution: HookExecution) => Promise<void>
	clearActiveHookExecution: () => Promise<void>
	getActiveHookExecution: () => Promise<HookExecution | undefined>

	// User prompt hook callback
	runUserPromptSubmitHook: (
		userContent: ClineContent[],
		context: "initial_task" | "resume" | "feedback",
	) => Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }>

	/** Update a cline message at the given index and notify the frontend. */
	updateClineMessage: (
		index: number,
		updates: { text?: string; exitCode?: number; commandStatus?: CommandStatus },
	) => Promise<void>
}

/**
 * Runtime validation function to ensure config has all required properties
 * Automatically derives expected keys from the interface definitions
 */
/** Return the canonical turn identity for one handler invocation. */
export function interactionTurnId(block: { dline_tid?: string }): string {
	if (!block.dline_tid) {
		throw new Error("Canonical tool interaction is missing dlineTid")
	}
	return `turn:${block.dline_tid}`
}

/** Return the canonical interaction identity for one handler invocation. */
export function interactionId(block: { dline_tid?: string }): string {
	if (!block.dline_tid) {
		throw new Error("Canonical tool interaction is missing dlineTid")
	}
	return block.dline_tid
}

export function validateTaskConfig(config: unknown): asserts config is TaskConfig {
	if (!isRecord(config)) {
		throw new Error("TaskConfig is null, undefined, or not an object")
	}

	for (const key of TASK_CONFIG_KEYS) {
		if (!(key in config)) {
			throw new Error(`Missing ${key} in TaskConfig`)
		}
	}

	if (typeof config.strictPlanModeEnabled !== "boolean") {
		throw new Error("strictPlanModeEnabled must be a boolean in TaskConfig")
	}

	if (!isRecord(config.services)) {
		throw new Error("services must be an object in TaskConfig")
	}
	for (const key of TASK_SERVICES_KEYS) {
		if (!(key in config.services)) {
			throw new Error(`Missing services.${key} in TaskConfig`)
		}
	}

	if (!isRecord(config.callbacks)) {
		throw new Error("callbacks must be an object in TaskConfig")
	}
	for (const key of TASK_CALLBACKS_KEYS) {
		if (typeof config.callbacks[key] !== "function") {
			throw new Error(`Missing or invalid callbacks.${key} in TaskConfig (must be a function)`)
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}
