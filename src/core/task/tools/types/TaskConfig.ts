import type { ApiHandler } from "@core/api"
import type { WebSearchRoutingPlan } from "@core/api/server-tools"
import type { IdentityFactory } from "@core/api/transform/block-identity"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import type { ImageGenerationService } from "@core/image-generation/ImageGenerationService"
import type { CommandPermissionController } from "@core/permissions"
import type { ExplicitInstructionAuthorization, ExplicitInstructionConsumePort } from "@core/task/explicit-instructions/types"
import type { ChecklistChange } from "@core/task/telemetry/ChecklistDiff"
import type { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { CommandCancellationResult, CommandExecutionOptions, CommandExecutionOutcome } from "@integrations/terminal"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import type { McpHub } from "@services/mcp/McpHub"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { BrowserSettings } from "@shared/BrowserSettings"
import type { CommandStatus, UiAsk, UiSay } from "@shared/ExtensionMessage"
import type { FocusChainSettings } from "@shared/FocusChainSettings"
import type { SubmittedInputRow } from "@shared/input-semantics/submitted-input"
import type { ClineContent, ClineToolResponseContent } from "@shared/messages/content"
import type { Mode } from "@shared/storage/types"
import type { TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import type { DlineDefaultTool } from "@shared/tools"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import { WorkspaceRootManager } from "@/core/workspace"
import type { ContextManager } from "../../../context/context-management/ContextManager"
import type { ContextBudgetLease } from "../../../context/context-management/context-budget-ledger"
import type { StateManager } from "../../../storage/StateManager"
import type { TaskActivityStore } from "../../activity/TaskActivityStore"
import type { BackgroundResultDeliveryPort } from "../../background/BackgroundResultDeliveryPort"
import type { PeerTaskSpawnPort } from "../../executors/spawn/PeerTaskSpawnPort"
import type { ToolAdmissionOutcome } from "../../executors/tool/ToolApprovalFeedbackLedger"
import type { ToolBlockStatePort } from "../../executors/tool/ToolBlockStatePort"
import type {
    CompleteInteractionRequest,
    InteractionOutcome,
    OpenInteractionRequest,
} from "../../interaction/InteractionProtocol"
import type { MessageStateHandler } from "../../message-state"
import type { HookExecution } from "../../types/HookExecution"
import type { ToolHandlerState } from "../state/ToolHandlerState"
import type { SubagentFanoutBudget } from "../subagent/SubagentFanoutBudget"
import type { SubagentJobManager } from "../subagent/SubagentJobManager"
import type { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { TASK_CALLBACKS_KEYS, TASK_CONFIG_KEYS, TASK_SERVICES_KEYS } from "../utils/ToolConstants"

/**
 * Strongly-typed configuration object passed to tool handlers
 */
/** Presentation-only request issued by one handler. */
export interface SayPresentationRequest {
    taskSay: UiSay
    presentation?: string
    images?: string[]
    files?: string[]
    existingTs?: number
}

/** Interaction and presentation boundary exposed to handlers. */
export interface TaskInteractionPorts {
    open(request: OpenInteractionRequest): Promise<InteractionOutcome>
    complete(request: CompleteInteractionRequest): Promise<InteractionOutcome>
    /**
     * Record that this completion's result is about to be shown, before it is.
     *
     * A terminate that lands while the completion is still committing then
     * leaves the task finished with this completion as its dialog. Never fails
     * the caller: without it a close in that window only loses the completion.
     */
    stageCompletion?(request: CompleteInteractionRequest): Promise<void>
    say(request: SayPresentationRequest): Promise<void>
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
    /** Why a hosted Web Search call is answered by the local engine; the local search shows it on the call's row. */
    webSearchFallbackNotice?: string
    /** Request-scoped one-shot authority for explicit-only tools. */
    explicitInstructions?: ExplicitInstructionConsumePort
    /** Authorization consumed by the central gate for the current complete handler invocation. */
    explicitInstructionAuthorization?: ExplicitInstructionAuthorization
    // Multi-workspace support (optional for backward compatibility)
    workspaceManager?: WorkspaceRootManager
    isMultiRootEnabled?: boolean

    // State management
    taskState: ToolHandlerState
    blockState: ToolBlockStatePort
    messageState: MessageStateHandler

    // API and services
    api: ApiHandler
    services: TaskServices

    // Settings
    autoApprovalSettings: AutoApprovalSettings
    browserSettings: BrowserSettings
    focusChainSettings: FocusChainSettings
    capabilityToggles: TaskCapabilityToggles

    // Typed interaction boundary
    interactions: TaskInteractionPorts
    /** Manual approval outcome delivered once to this handler invocation. */
    admissionOutcome?: ToolAdmissionOutcome

    // Callbacks (strongly typed)
    callbacks: TaskCallbacks

    // Tool coordination
    coordinator: ToolExecutorCoordinator
    /** Task-local allocator for result item identities. */
    identityFactory: IdentityFactory
    /** Task-local real-time activity state shared by chat and the Activity view. */
    activityStore?: TaskActivityStore

    /** Host-owned peer-task launcher; absent on headless runtimes. */
    peerTaskSpawner?: PeerTaskSpawnPort

    /** Producer-owned durable ingress for background command and subagent results. */
    backgroundResults?: BackgroundResultDeliveryPort
    /** Task-local background subagent job manager. */
    subagentJobManager?: SubagentJobManager

    /**
     * Task-scoped budget bounding how many subagents execute at once.
     *
     * Held on the task rather than per fan-out call so nested fan-out competes
     * for the same allowance instead of multiplying the configured limit.
     */
    subagentFanoutBudget?: SubagentFanoutBudget

    /**
     * This call's share of the task context budget. Handlers that bound their
     * own results take their byte cap from it; calls made outside a task turn
     * have none and keep the fixed tool result limit.
     */
    contextBudget?: ContextBudgetLease
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
        type: UiSay,
        text?: string,
        images?: string[],
        files?: string[],
        partial?: boolean,
        existingTs?: number,
        /**
         * `ts` of the command row this message belongs to.
         *
         * A `command_output` row is only merged into its command by this key, so a
         * host that drops it leaves the output orphaned and never rendered.
         */
        commandTs?: number,
    ) => Promise<number | undefined>

    /**
     * Show the user's own reply row built from what they submitted.
     *
     * Used for a structured reply instead of `say`, which only carries flat
     * attachments: the row names each resource and keeps the reply's submitted
     * facts, and never the image data or paths its receiver resolved. Required,
     * so a host cannot silently fall back to showing the resolved content.
     */
    sayUserReply: (row: SubmittedInputRow) => Promise<void>

    focusChainForceUpdate: (newPlan: string) => Promise<void>

    ask: (
        type: UiAsk,
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

    /**
     * Commit a workspace restore point.
     *
     * Optional for the same reason as the checklist: a task that only produces
     * an answer has no workspace history to step back through.
     */
    saveCheckpoint?: (isAttemptCompletionMessage?: boolean, completionMessageTs?: number) => Promise<void>

    /** Enter a bounded mutation after the prior baseline; settle it when the tool stops writing. */
    beginWorkspaceMutation?: () => Promise<() => void>

    sayAndCreateMissingParamError: (
        toolName: DlineDefaultTool,
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

    /** `completionMessageTs` names the completion row, which its dialog may already have rewritten. */
    doesLatestTaskCompletionHaveNewChanges: (completionMessageTs?: number) => Promise<boolean>

    /**
     * Publish the checklist a tool call carried.
     *
     * Optional because a checklist belongs to the surface, not to tool
     * execution: a task instantiated to generate a title, review a change, or
     * decide an approval presents none, and must not have to supply a stub.
     */
    updateFCListFromToolResponse?: (taskProgress: string | undefined) => Promise<void>

    /**
     * Report what changed in the checklist a call carried.
     *
     * Optional for the same reason: a surface without a checklist has nothing to
     * observe, and an absent callback must stay distinguishable from an empty one.
     */
    observeChecklist?: (changes: readonly ChecklistChange[]) => void

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
