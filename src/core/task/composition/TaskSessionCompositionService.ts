import { randomUUID } from "node:crypto"
import type { ToolUse } from "@core/assistant-message"
import { collectContextWindowRequestPressures } from "@core/context/context-management/context-pressure"
import { getContextWindowInfo } from "@core/context/context-management/context-window-utils"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { LegacyInputAdapter } from "@core/input-semantics/LegacyInputAdapter"
import { SemanticInputAdmissionService } from "@core/input-semantics/SemanticInputAdmissionService"
import { StoreResourceVerifier } from "@core/input-semantics/StoreResourceVerifier"
import { TaskCommandExpander, TaskMentionResolver } from "@core/input-semantics/TaskEntityResolvers"
import { openTaskInputResources } from "@core/input-semantics/TaskInputResourceStore"
import { TaskSemanticInputAdmission } from "@core/input-semantics/TaskSemanticInputAdmission"
import { formatResponse } from "@core/prompts/responses"
import type { StateManager } from "@core/storage/StateManager"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import type { HistoryItem } from "@shared/HistoryItem"
import { Logger } from "@shared/services/Logger"
import type { TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import type { ApiConversation } from "../../storage/ApiConversation"
import type { UIMessage } from "../../storage/UIMessage"
import { TaskActivityPersistence } from "../activity/TaskActivityPersistence"
import { TaskActivityStore } from "../activity/TaskActivityStore"
import { formatBackgroundCommandResult } from "../background/BackgroundContextInjector"
import { CanonicalCheckpointRepository, canonicalCheckpointRef } from "../checkpoints/CanonicalCheckpointRepository"
import { renderCompactionInstruction } from "../compaction/CompactionInstruction"
import { CompactionRequestScopes } from "../compaction/CompactionRequestScopes"
import { CompactionRoundBarrier } from "../compaction/CompactionRoundBarrier"
import { CompositeCompactionLanding, PromptStateCompactionLanding } from "../compaction/CompactionSummaryLanding"
import { ContextUsageCompactionLanding } from "../compaction/ContextUsageCompactionLanding"
import { FinalContextWindowGuard } from "../compaction/FinalContextWindowGuard"
import { InteractionCompactionReview } from "../compaction/InteractionCompactionReview"
import { MessageStateCompactionCards } from "../compaction/MessageStateCompactionCards"
import { MessageStateCompactionFailure } from "../compaction/MessageStateCompactionFailure"
import { MessageStateCompactionLanding } from "../compaction/MessageStateCompactionLanding"
import { ProviderCompactionService } from "../compaction/ProviderCompactionService"
import { DefaultProductionProviderService } from "../executors/provider/service/DefaultProductionProviderService"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import { ProviderRetryGate } from "../executors/provider/service/ProviderRetryGate"
import { DefaultProductionToolExecutionService } from "../executors/tool/production/DefaultProductionToolExecutionService"
import { ProductionToolHandlerRuntime } from "../executors/tool/production/ProductionToolHandlerRuntime"
import { TaskTurnAuthority } from "../explicit-instructions/TurnAuthority"
import type { TaskCompletionProjection, TaskCompletionProjectionUpdate } from "../history/TaskCompletionProjector"
import { TaskCompletionProjector } from "../history/TaskCompletionProjector"
import type { TaskState } from "../kernel"
import { MessageStateHandler } from "../message-state"
import { buildNewTaskFeedbackContent, findLatestNewTaskFeedback, perRequestHistory } from "../new-task/new-task-feedback"
import { observeTaskStateVault, TaskTurnTelemetry } from "../observability/task-turn-telemetry"
import { formatApiRequestTiming } from "../performance/api-request-timing"
import { TaskPerformanceOwner } from "../performance/TaskPerformanceOwner"
import { TaskPerformanceRequestReporter } from "../performance/TaskPerformanceRequestReporter"
import { TaskPromptContextOwner } from "../prompt/TaskPromptContextOwner"
import { TaskPromptLifecycle } from "../prompt/TaskPromptLifecycle"
import { PromptCacheHealthTracker } from "../prompt-cache/PromptCacheHealthTracker"
import { createRequestApiScope } from "../RequestApiScope"
import { LoggingRuntimeDiagnostics } from "../runtime"
import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import { HostedServerToolPresenter } from "../session/HostedServerToolPresenter"
import { InitialCheckpointRequestReporter } from "../session/InitialCheckpointRequestReporter"
import { createPresentationIdSequence } from "../session/PresentationIdSequence"
import { createHostPresentationPacing, ProviderTextPresenter } from "../session/ProviderTextPresenter"
import type { RealtimeMessagePublisher } from "../session/RealtimeMessagePublisher"
import { readRestoredContextPressure } from "../session/RestoredContextPressure"
import { RestoredToolDialogContinuation } from "../session/RestoredToolDialogContinuation"
import { RetainedInputPresenter } from "../session/RetainedInputPresenter"
import { SessionResourceScope } from "../session/SessionResourceScope"
import { TaskApiHandlerOwner } from "../session/TaskApiHandlerOwner"
import { TaskBackgroundIngressOwner } from "../session/TaskBackgroundIngressOwner"
import { TaskCollaborationSessionOwner } from "../session/TaskCollaborationSessionOwner"
import { createTaskContextBudget } from "../session/TaskContextBudget"
import { isRunAtRest, TaskContextUsageProjection } from "../session/TaskContextUsageProjection"
import { TaskEnvironmentOwner } from "../session/TaskEnvironmentOwner"
import { TaskInputPresenter } from "../session/TaskInputPresenter"
import { TaskInteractionOwner } from "../session/TaskInteractionOwner"
import { TaskProviderRequestFactory } from "../session/TaskProviderRequestFactory"
import { resolveCompactTriggerTokens, TaskProviderRequestReporter } from "../session/TaskProviderRequestReporter"
import { openActiveTaskSession } from "../session/TaskSessionFactory"
import type { TaskSessionOwners } from "../session/TaskSessionOwners"
import { TaskToolExecutionOwner } from "../session/TaskToolExecutionOwner"
import { TurnContinuationRenderer } from "../session/TurnContinuationRenderer"
import type { TaskResumptionPort as ResumeDialogContinuationPorts } from "../session/UnownedDialogContinuation"
import { ResumeDialogContinuation } from "../session/UnownedDialogContinuation"
import { restoreCheckpoint as restoreCanonicalCheckpoint } from "../shell/checkpoint-restore"
import { openTaskPersistence, type TaskPersistenceAssembly } from "../shell/TaskPersistenceAssembly"
import { InMemoryBackgroundDeliveryLedger, type TaskViewPort } from "../stores"
import { JournalConversationRewind } from "../stores/JournalConversationRewind"
import { TaskStateManager } from "../TaskStateManager"
import { withTerminateTimeout } from "../TaskTerminateTimeout"
import { RoundCheckpointLedger } from "../tools/RoundCheckpointLedger"
import { DefaultToolHandlerState } from "../tools/state/ToolHandlerState"
import { ToolValidator } from "../tools/ToolValidator"
import type { TaskSessionHostFactory } from "./TaskSessionHostFactory"
import type { TaskSessionPorts } from "./TaskSessionPorts"
import { importTaskUpgrade, taskUpgradeImportPending } from "./TaskUpgradeImport"

/**
 * Message stores the caller opened for this incarnation.
 *
 * Ownership passes to the session on `open`: disposing the session closes them,
 * and so does a failed open. `uiMessage` holds the single writer of the task's
 * `messages.db`, so a store left open would refuse every write of the next
 * incarnation opened in this window.
 */
export interface TaskSessionMessageHost {
    readonly uiMessage: UIMessage
    readonly apiConversation: ApiConversation
    readonly taskIsFavorited?: boolean
    readonly legacyConversationHistoryDeletedRange?: readonly [number, number]
    readonly updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
    readonly publishTaskHistoryClose?: () => void
    /**
     * Where the task's completion verdict is kept in History.
     *
     * `initial` is the verdict History already holds, so reopening a finished
     * task does not rewrite it; `persist` accepts a changed verdict.
     */
    readonly completion?: {
        readonly initial?: TaskCompletionProjection
        readonly persist: (update: TaskCompletionProjectionUpdate) => Promise<boolean>
    }
}

export interface TaskSessionPromptHost {
    readonly ports: TaskSessionPorts
    readonly ignoreController: IgnoreController
    readonly workspaceManager?: WorkspaceRootManager
    readonly terminalExecutionMode: "vscodeTerminal" | "backgroundExec"
    readonly readCapabilityToggles: () => TaskCapabilityToggles
    readonly shouldUseNativeToolCalls: Parameters<TaskPromptContextOwner["build"]>[0] extends infer _Provider
        ? (provider: Parameters<TaskPromptContextOwner["build"]>[0]) => boolean
        : never
    readonly resolveParallelToolCallingEnabled: (provider: Parameters<TaskPromptContextOwner["build"]>[0]) => boolean
    readonly getParentTaskId: () => Promise<string | undefined>
}

export interface OpenTaskSessionCompositionOptions {
    readonly taskId: string
    readonly collaboration: {
        readonly writable: boolean
        readonly summary: string
        readonly kind: "main" | "spawned"
        readonly createdAt: string
    }
    readonly taskIncarnationId?: string
    readonly openReason: "new" | "resume" | "crash_recovery" | "checkpoint_restore"
    /**
     * The opening window does not own the task lock yet: recovered commands wait for
     * `Task.open()` instead of writing the databases the lock owner is writing.
     */
    readonly deferRestoredCommands?: boolean
    readonly cwd: string
    readonly stateManager: StateManager
    readonly taskView: TaskViewPort
    readonly messages: TaskSessionMessageHost
    readonly prompt: TaskSessionPromptHost
    readonly hostFactory: TaskSessionHostFactory
    readonly publishState: (options?: { readonly immediate?: boolean }) => Promise<void>
    /** The context-window figure the task showed when it last stopped. */
    readonly restoredContextWindowIndicator?: ContextWindowIndicatorSnapshot
}

/** The only production composition root for one task incarnation. */
export class TaskSessionCompositionService {
    async open(options: OpenTaskSessionCompositionOptions): Promise<ActiveTaskSession> {
        let persistence: TaskPersistenceAssembly | undefined
        const resources = new SessionResourceScope()
        // Storage closes last: the later owners may still commit while stopping.
        resources.add({ release: async () => persistence?.close?.() })
        resources.add({ release: () => options.messages.uiMessage.close() })
        resources.add({ release: () => options.messages.apiConversation.close() })
        try {
            persistence = await openTaskPersistence(options.taskId)
            return await this.compose(options, persistence, resources)
        } catch (error) {
            try {
                await resources.release()
            } catch (cleanupError) {
                Logger.error(`[Task ${options.taskId}] Failed to release resources after session open failed`, cleanupError)
            }
            throw error
        }
    }

    private async compose(
        options: OpenTaskSessionCompositionOptions,
        persistence: TaskPersistenceAssembly,
        resources: SessionResourceScope,
    ): Promise<ActiveTaskSession> {
        const taskIncarnationId = options.taskIncarnationId ?? randomUUID()
        const upgrade = {
            taskId: options.taskId,
            persistence,
            apiHistory: options.messages.apiConversation.getAll(),
            uiMessages: options.messages.uiMessage.getAll(),
            conversationHistoryDeletedRange: options.messages.legacyConversationHistoryDeletedRange,
        }
        // A window without the task lock must not write the stores; its session
        // records the pending import so the window reopens it once it owns them.
        let upgradeImportPending = false
        if (options.deferRestoredCommands) upgradeImportPending = await taskUpgradeImportPending(upgrade)
        else await importTaskUpgrade(upgrade)
        const settings = new TaskStateManager(options.taskId, options.stateManager)
        const toolState = new DefaultToolHandlerState()
        // One view per task: requests, compaction and every conversation reader
        // share it, and each journal payload is rendered once rather than once per round.
        // Admitted inputs place resources by reference; the request reads their
        // verified bytes from the task's own store when it is materialized.
        const journalMessages = new ProviderJournalMessageMaterializer(
            persistence.payloads,
            openTaskInputResources(options.taskId),
        )
        const conversationView = new JournalConversationView(persistence.ports.journal, journalMessages)
        const providerConversation = { messages: () => conversationView.providerMessages() }
        const conversationRewind = new JournalConversationRewind(persistence.ports.journal, conversationView)
        const checkpointRepository = new CanonicalCheckpointRepository({
            taskId: options.taskId,
            vault: persistence.ports.vault,
            journal: persistence.ports.journal,
            payloads: persistence.payloads,
        })
        const messages = new MessageStateHandler({
            taskId: options.taskId,
            ulid: taskIncarnationId,
            taskIsFavorited: options.messages.taskIsFavorited,
            updateTaskHistory: options.messages.updateTaskHistory,
            publishTaskHistoryClose: options.messages.publishTaskHistoryClose,
            metadata: toolState,
            uiMessage: options.messages.uiMessage,
            apiConversation: options.messages.apiConversation,
            conversation: conversationView,
        })
        const activityPersistence = new TaskActivityPersistence(options.taskId)
        resources.add({ release: () => activityPersistence.close() })
        const activities = new TaskActivityStore(options.taskId, activityPersistence)
        resources.add({
            release: async () => {
                try {
                    await activities.waitForPersistence()
                } finally {
                    activities.dispose()
                }
            },
        })
        await activities.hydrate()
        let session: ActiveTaskSession | undefined
        let collaboration: TaskCollaborationSessionOwner | undefined
        // The whole auto-condense setting group defines the trigger and the window a
        // compaction may use. Passing only the percent would silently ignore the
        // reserve bounds and the absolute cap the user configured.
        const readCompactTriggerOptions = () => ({
            triggerPercent: options.stateManager.getGlobalSettingsKey("autoCondenseTriggerPercent"),
            minReserveTokens: options.stateManager.getGlobalSettingsKey("autoCondenseMinReserveTokens"),
            maxReserveTokens: options.stateManager.getGlobalSettingsKey("autoCondenseMaxReserveTokens"),
            maxContextTokens: options.stateManager.getGlobalSettingsKey("autoCondenseMaxContextTokens"),
        })
        // Results count against the context the moment they are produced, not
        // when the next request reports them, so the calls of one round share
        // its budget instead of each assuming all the room is theirs. The budget
        // only bounds tool results; it never moves where compaction starts.
        // The readings are deferred, so the handler created below is read when used.
        const contextBudget = createTaskContextBudget({
            api: () => api.current(),
            indicator: () => toolState.contextWindowIndicator,
            messages: () => messages.clineMessages,
            contextSettings: readCompactTriggerOptions,
        })
        // A settled background result waits in the durable ledger while the
        // conversation has no room for it, and is delivered once compaction makes room.
        const backgroundIngress = new TaskBackgroundIngressOwner(
            () => this.requireSession(session),
            persistence.backgroundDeliveries ?? new InMemoryBackgroundDeliveryLedger(),
            contextBudget,
        )
        // Command dispatch, publication, commit and unowned dialog continuation all
        // run with no caller to reject, so one sink carries every decision they
        // make. A task that stops replaying restored commands, or accepts an answer
        // nothing acts on, is otherwise indistinguishable from one with no work.
        const diagnostics = new LoggingRuntimeDiagnostics(options.taskId, (message, severity) =>
            severity === "failure" ? Logger.error(message) : Logger.debug(message),
        )
        // A recovery or wakeup dialog is planned by the kernel, so answering it has
        // no receiver to hand the outcome to. Resuming means submitting the answer
        // as an ordinary input, which only the opened session can do. A restored
        // tool dialog is the exception: its answer is the tool's result.
        const resumption: ResumeDialogContinuationPorts = {
            materialize: (input, options) => this.requireSession(session).inputs.materialize(input, "queued", options),
            submit: (input) => this.requireSession(session).task.submitInput(input),
        }
        // The footer shows Retry and Cancel only while a countdown owns the
        // request, so every change of that ownership republishes the view. A
        // Retry answered on a failed request hands that request to the user.
        const providerRetry = new ProviderRetryGate(() => void options.publishState().catch(() => undefined))
        // Numbers the requests this session timed, for the diagnostic line each one logs.
        let timedRequests = 0
        const interactions = new TaskInteractionOwner(
            messages,
            persistence.payloads,
            new RestoredToolDialogContinuation(
                {
                    state: () => this.requireSession(session).state(),
                    payloads: persistence.payloads,
                    journal: persistence.ports.journal,
                    messages,
                    nextPresentationId: () => nextPresentationId(),
                    publishRow: (row) => options.prompt.ports.presentation.publish(row),
                },
                resumption,
                new ResumeDialogContinuation(resumption, () => toolState.resetMistakeLimitState(), providerRetry),
            ),
            diagnostics,
            (row) => options.prompt.ports.presentation.publish(row),
        )
        resources.add({ release: async () => interactions.dispose() })
        const api = new TaskApiHandlerOwner({
            taskId: options.taskId,
            taskIncarnationId,
            stateManager: options.stateManager,
            settings,
        })
        const promptCache = new PromptCacheHealthTracker(options.taskId, {
            debug: (message) => Logger.debug(message),
            warn: (message) => Logger.warn(message),
        })
        const readState = (): Readonly<TaskState> => this.requireSession(session).state()
        const performance = await TaskPerformanceOwner.open({
            taskId: options.taskId,
            readState,
            legacyMessages: () => messages.clineMessages,
            onChanged: () => void options.publishState().catch(() => undefined),
        })
        resources.add({ release: () => performance.release() })
        const taskTelemetry = new TaskTurnTelemetry(options.taskId, readState, () => performance.getSnapshot())
        taskTelemetry.registerAlias(taskIncarnationId)
        resources.add({
            release: async () => {
                taskTelemetry.dispose()
            },
        })
        const runtimePersistence: TaskPersistenceAssembly = {
            ...persistence,
            ports: { ...persistence.ports, vault: observeTaskStateVault(persistence.ports.vault, taskTelemetry) },
        }
        const completionHost = options.messages.completion
        const completion = completionHost
            ? new TaskCompletionProjector({
                  taskId: options.taskId,
                  initial: completionHost.initial,
                  persist: completionHost.persist,
              })
            : undefined
        const promptContext = new TaskPromptContextOwner({
            identity: { taskId: options.taskId, cwd: options.cwd },
            host: options.prompt.ports.promptContext,
            stateManager: options.stateManager,
            taskStateManager: settings,
            getMessageStateHandler: () => messages,
            workspace: {
                ignoreController: options.prompt.ignoreController,
                manager: options.prompt.workspaceManager,
                getPrimaryWorkspaceName: () => options.prompt.workspaceManager?.getPrimaryRoot()?.name ?? "workspace",
            },
            runtime: {
                getMode: () => settings.mode,
                getTaskCapabilityToggles: options.prompt.readCapabilityToggles,
                shouldUseNativeToolCalls: options.prompt.shouldUseNativeToolCalls,
                resolveParallelToolCallingEnabled: options.prompt.resolveParallelToolCallingEnabled,
                getParentTaskId: options.prompt.getParentTaskId,
            },
            terminalExecutionMode: options.prompt.terminalExecutionMode,
        })
        const buildPromptContext = async () => {
            const scope = createRequestApiScope(
                api.current(),
                settings.mode,
                options.stateManager.getGlobalSettingsKey("customPrompt"),
                options.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true,
                undefined,
                options.stateManager.getCanonicalSettingsKey("imageGenerationEnabled") === true,
                options.prompt.shouldUseNativeToolCalls,
            )
            return promptContext.build(scope.providerInfo, scope.webToolsEnabled, scope.webSearchRoutingPlan)
        }
        const usesNativeToolCalls = () =>
            options.prompt.shouldUseNativeToolCalls(
                createRequestApiScope(
                    api.current(),
                    settings.mode,
                    options.stateManager.getGlobalSettingsKey("customPrompt"),
                    options.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true,
                    undefined,
                    options.stateManager.getCanonicalSettingsKey("imageGenerationEnabled") === true,
                ).providerInfo,
            )
        const prompt = new TaskPromptLifecycle({
            taskId: options.taskId,
            cwd: options.cwd,
            ignoreController: options.prompt.ignoreController,
            buildPromptContext,
            publishState: options.publishState,
        })
        resources.add({ release: () => prompt.dispose() })
        prompt.start()
        // One sequence orders every chat row of the session, the host's included.
        const nextPresentationId = createPresentationIdSequence(Date.now, () => messages.latestMessageTs())
        const tool = await options.hostFactory.create({
            taskId: options.taskId,
            taskIncarnationId,
            cwd: options.cwd,
            settings,
            messages,
            activities,
            api,
            prompt,
            promptCache,
            toolState,
            interactions,
            nextPresentationId,
            readState,
            checkpoints: {
                capture: async (input) => {
                    await checkpointRepository.capture({
                        checkpointRef: canonicalCheckpointRef(options.taskId, input.messageTs),
                        ...(input.workspaceRef === undefined ? {} : { workspaceRef: input.workspaceRef }),
                    })
                },
                restore: async (input) => {
                    const checkpointRef = canonicalCheckpointRef(options.taskId, input.messageTs)
                    let fence: Awaited<ReturnType<ActiveTaskSession["stopForCheckpointRestore"]>> | undefined
                    const result = await restoreCanonicalCheckpoint(
                        { taskId: options.taskId, checkpointRef, mode: input.mode },
                        {
                            stopAndFence: async () => {
                                fence = await this.requireSession(session).stopForCheckpointRestore(
                                    `checkpoint.restore:${input.messageTs}:${randomUUID()}`,
                                )
                            },
                            resolve: () =>
                                input.journalTarget
                                    ? checkpointRepository.resolveAt(input.journalTarget)
                                    : checkpointRepository.resolve(checkpointRef),
                            restoreWorkspace: input.restoreWorkspace,
                            applyConversationBoundary: async (boundary) => {
                                await conversationRewind.rewindTo({
                                    operationId: `checkpoint.restore:${checkpointRef}`,
                                    target: boundary,
                                })
                                return boundary
                            },
                            save: (snapshot) => persistence.ports.vault.save(snapshot),
                        },
                    )
                    return { result, ...(fence === undefined ? {} : { fence }) }
                },
            },
            // A chat restore undoes what was said after the restored row in the
            // conversation the provider is sent, which only this task's journal holds.
            conversationRewind,
        })
        resources.add({ release: () => tool.browser.dispose() })
        resources.add({
            release: async () => {
                try {
                    await cancelRunningActivities(activities)
                } finally {
                    await tool.commands.dispose()
                }
            },
        })
        for (const release of tool.releases ?? []) resources.add(release)
        tool.commands.bindBackgroundCommandSettlement({
            settled: (command) =>
                backgroundIngress.publish({
                    entryId: `background:command:${command.id}:attempt:1`,
                    producerKind: "command",
                    producerId: command.id,
                    attempt: 1,
                    text: ["# Background Results", "## Background Command Results", formatBackgroundCommandResult(command)].join(
                        "\n",
                    ),
                    acknowledge: () => undefined,
                }),
        })
        const toolRuntime = new ProductionToolHandlerRuntime(new ToolValidator(options.prompt.ignoreController))
        // One owner per task session: the provider request grants the turn's
        // authority and the tool gate reads it back under the same turn identity.
        const turnAuthority = new TaskTurnAuthority()
        // File edits commit a restore point per call; commands, MCP calls and other
        // workspace-affecting tools share one restore point per round, settled by
        // the tool executor at the round boundary.
        const roundCheckpoints = new RoundCheckpointLedger(() => tool.callbacks.saveCheckpoint?.() ?? Promise.resolve())
        const toolExecution = new TaskToolExecutionOwner({
            taskId: options.taskId,
            taskIncarnationId,
            cwd: options.cwd,
            toolRuntime,
            stateManager: options.stateManager,
            settings,
            messages,
            payloads: persistence.payloads,
            activities,
            backgroundResults: backgroundIngress,
            api,
            toolState,
            services: tool.services,
            interactions,
            callbacks: roundCheckpoints.bind(tool.callbacks),
            readState,
            readCapabilityToggles: options.prompt.readCapabilityToggles,
            readTurnAuthority: (turnId) => turnAuthority.read(turnId),
            workspaceManager: options.prompt.workspaceManager,
            providerRequestRounds: performance.providerRequestRounds,
            peerTaskSpawner: tool.peerTaskSpawner,
            terminalExecutionMode: options.prompt.terminalExecutionMode,
            usesNativeToolCalls: options.prompt.shouldUseNativeToolCalls,
        })
        const environment = tool.terminals
            ? new TaskEnvironmentOwner({
                  taskId: options.taskId,
                  cwd: options.cwd,
                  host: options.prompt.ports.environment,
                  stateManager: options.stateManager,
                  settings,
                  api,
                  messages,
                  toolState,
                  services: tool.services,
                  ignoreController: options.prompt.ignoreController,
                  workspaceManager: options.prompt.workspaceManager,
                  terminals: tool.terminals,
                  commands: tool.commands,
                  subagents: toolExecution,
                  readState,
                  focusChain: tool.focusChain,
              })
            : undefined
        const providerRequests = new TaskProviderRequestFactory({
            taskId: options.taskId,
            stateManager: options.stateManager,
            settings,
            api,
            promptContext,
            prompt,
            conversation: conversationView,
            messages: journalMessages,
            authority: turnAuthority,
            tools: toolRuntime,
            readAdmissionSnapshot: (block) => toolExecution.readAdmissionSnapshot(block),
            usesNativeToolCalls: options.prompt.shouldUseNativeToolCalls,
        })
        const realtimeMessages: RealtimeMessagePublisher = {
            publish: (row) => {
                void options.prompt.ports.presentation
                    .publish(row)
                    .catch((error) =>
                        Logger.debug(`[Task ${options.taskId}] Realtime message could not reach the Webview: ${String(error)}`),
                    )
            },
        }
        // A reply that calls no tool has no block to render it, so the prose
        // itself is what the chat must show. The presenter paces every streamed
        // row, tool calls included, so it is released with the session.
        const providerPresentation = new ProviderTextPresenter(
            messages,
            nextPresentationId,
            realtimeMessages,
            async (projection) => {
                if (projection.kind !== "provider.tool_partial") return
                const block = projection.block
                if (!block || typeof block !== "object") return
                await toolExecution.presentPartial(block as ToolUse)
            },
            createHostPresentationPacing(() => options.prompt.ports.environment.getHostVersion()),
        )
        resources.add({ release: () => providerPresentation.dispose() })
        const compactionScopes = new CompactionRequestScopes()
        // One barrier for both causes a round owes a compaction: a settled
        // request reporting the context is full, and a `/compact` an admitted
        // input carries. Either way the next round waits on it before it is composed.
        const compaction = new CompactionRoundBarrier({
            session: () => session,
            state: readState,
            // Automatic compaction is a user setting; without it the task keeps
            // the conversation whole and lets the user condense it by hand.
            enabled: () => options.stateManager.getGlobalSettingsKey("useAutoCondense") === true,
            onFailure: (message) => Logger.warn(message),
        })
        const owners: TaskSessionOwners = {
            identity: { taskId: options.taskId, taskIncarnationId },
            nextPresentationId,
            compactionScopes,
            // The barrier is what saw the automatic compaction fail, so it alone
            // knows when truncating is the way out it leaves the user.
            compactionRecovery: compaction,
            providerRetry,
            settings,
            messages,
            activities,
            api,
            prompt,
            promptCache,
            toolState,
            toolExecution,
            interactions,
            browser: tool.browser,
            commands: tool.commands,
            files: tool.services.taskFileTracker,
            checkpoints: tool.checkpoints,
            apiRateSnapshot: () => performance.getSnapshot(),
            queryRateMetrics: (query) => performance.query(query),
        }
        // The pressure a settled request reported lives in memory, so a task
        // reopened by a chat restore would send one uncompacted request before
        // noticing that the rewound conversation is still full. Only a restore
        // seeds it: an ordinary resume keeps the conversation it already fitted.
        if (options.openReason === "checkpoint_restore") {
            const trigger = resolveCompactTriggerTokens(
                getContextWindowInfo(api.current()).contextWindow,
                readCompactTriggerOptions(),
            )
            const restored = readRestoredContextPressure(messages.clineMessages, trigger)
            if (restored) compaction.observe(restored)
        }
        // The Profile the task's current Mode runs under: the task's own binding,
        // or the configuration's when the task never chose one.
        const activeProfile = () => {
            const configuration = options.stateManager.getApiConfigurationForTask(options.taskId)
            const plan = settings.mode === "plan"
            return {
                profileId:
                    (plan ? settings.planModeProfileId : settings.actModeProfileId) ??
                    (plan ? configuration.planModeProfileId : configuration.actModeProfileId),
                profileName:
                    (plan ? settings.planModeProfile : settings.actModeProfile) ??
                    (plan ? configuration.planModeProfile : configuration.actModeProfile),
            }
        }
        // The Task Header draws its usage bar from the snapshot the controller
        // reads off the tool state, so the projection writes it there.
        const contextUsage = new TaskContextUsageProjection({
            taskId: options.taskId,
            target: toolState,
            scope: () => ({
                mode: settings.mode,
                ...activeProfile(),
                contextWindow: getContextWindowInfo(api.current()).contextWindow,
            }),
            publish: options.publishState,
            // Saved with the history row, which is what a reopened task draws first.
            settled: () => void messages.updateTaskHistory(),
            // The figure now carries the results the round composed, so the
            // budget stops counting them on top of it.
            tailCounted: () => contextBudget.retireCheckpoint(),
            // A checkpoint restore rewinds the conversation, so the figure from
            // before it describes a context the task no longer has.
            restored: options.openReason === "checkpoint_restore" ? undefined : options.restoredContextWindowIndicator,
        })
        // Every Mode, Profile, or configuration switch ends in a handler rebuild,
        // and the header must then describe the scope the task runs under.
        api.onRebuilt(() => contextUsage.rebound())
        // Each Pass, and a Pass that broke off and is sent again, shows its own card
        // while the run works; the landed summary or the failure card takes over
        // the last one.
        const compactionCards = new MessageStateCompactionCards(messages, nextPresentationId, realtimeMessages)
        // A run that produced nothing left the conversation as it was, which the
        // user cannot see unless the chat says so.
        const compactionFailure = new MessageStateCompactionFailure(compactionCards)
        // The request itself, not the last one's usage, decides whether a round
        // fits; it is measured on the same frame the request is sent with.
        const contextWindowGuard = new FinalContextWindowGuard({
            taskId: options.taskId,
            frames: providerRequests,
            conversation: providerConversation,
            requestPressures: () => collectContextWindowRequestPressures(messages.clineMessages),
            triggerOptions: readCompactTriggerOptions,
            compaction,
            failure: compactionFailure,
        })
        const opened = await openActiveTaskSession({
            taskId: options.taskId,
            openReason: options.openReason,
            deferRestoredCommands: options.deferRestoredCommands,
            upgradeImportPending,
            readAnchorRows: () => messages.durableClineMessages,
            persistence: runtimePersistence,
            conversationView,
            // A request's figure stays in flight until the run it belongs to comes
            // to rest, and only a committed state says when that is.
            taskView: {
                notifyCommitted: async (state) => {
                    taskTelemetry.committed("runtime.state.committed", state)
                    // Applied first and synchronously, so the view it informs never
                    // delays the figure and a failing view cannot skip it.
                    contextUsage.committed(state)
                    compaction.committed(state)
                    collaboration?.committed(state)
                    performance.committed(state, isRunAtRest(state))
                    // The verdict reaches History before the view reads it back.
                    await completion?.sync(state).catch((error: unknown) => {
                        Logger.warn(
                            `[TaskSessionComposition] ${options.taskId}: completion projection failed: ${error instanceof Error ? error.message : String(error)}`,
                        )
                    })
                    await options.taskView.notifyCommitted(state)
                },
                notifyTransient: (taskId, projection) => options.taskView.notifyTransient(taskId, projection),
            },
            diagnostics,
            owners,
            inputAdmission: this.composeInputAdmission(options, taskIncarnationId, tool.services, api, settings),
            // A `/compact` the user types is carried out by the compaction barrier,
            // so its guidance shapes the summary instead of reaching the model.
            lifecycleBarriers: compaction,
            inputPresentation: new TaskInputPresenter(persistence.payloads, messages, nextPresentationId),
            retainedInputPresentation: new RetainedInputPresenter(persistence.payloads, messages, nextPresentationId),
            // A refused call reports what the refusal left behind, which only its handler knows.
            toolDenial: { describe: (invocationRef) => toolExecution.describeDenial(invocationRef) },
            // User input or a refused call between two calls means the second does not follow
            // the first, so guards that compare consecutive calls must start over.
            toolSequence: { interrupt: () => toolState.interruptToolSequence() },
            // A round that would overflow the window waits for the summary first,
            // so the request it sends is the one that fits. It guards compose
            // rather than submission because the kernel also opens rounds on its
            // own, and those must not skip the barrier. The tail the round adds is
            // handed to the header first, so a compaction it schedules is shown
            // carrying what it condenses.
            compactionBarrier: {
                settleBeforeRound: (input) => {
                    contextUsage.staged({ pendingContextTokens: input.pendingContextTokens ?? 0 })
                    // The round carries every result produced so far. They stay
                    // counted until its request opens or a summary replaces them,
                    // since compose or compaction may still stop before either.
                    contextBudget.checkpoint()
                    return compaction.settleBeforeRound(input)
                },
            },
            contextWindowGuard,
            // The barrier releases when the whole run ends, so it observes the
            // executor port rather than the provider call inside it.
            compactionSettlement: compaction,
            // A summary only shrinks the context once it replaces the history it
            // summarized and is shown as the card the user can restore from; the
            // header then reads the condensed figure instead of waiting for the
            // next request to report it.
            compactionLanding: new CompositeCompactionLanding([
                new MessageStateCompactionLanding(compactionCards),
                new ContextUsageCompactionLanding({
                    frames: providerRequests,
                    conversation: providerConversation,
                    usage: contextUsage,
                }),
                new PromptStateCompactionLanding(prompt, promptCache),
                // Results that waited for room are delivered once the summary freed it.
                { land: () => backgroundIngress.releaseHeld() },
            ]),
            // A summary the user asked for is theirs to accept or regenerate before
            // it replaces the conversation, through the same dialog every task uses.
            compactionReview: new InteractionCompactionReview(interactions),
            compactionFailure,
            compactionProgress: compactionCards,
            // A `new_task` hands the conversation to a successor on the same
            // surface. The Controller owns that surface, so it starts the successor
            // once the runtime has durably marked this task consumed.
            successor: {
                settings: () => ({
                    mode: settings.mode,
                    planModeProfileId: settings.planModeProfileId,
                    planModeProfile: settings.planModeProfile,
                    actModeProfileId: settings.actModeProfileId,
                    actModeProfile: settings.actModeProfile,
                }),
                // Read after the source is consumed, so the conversation is the one
                // the user approved and its Regenerate Context rows are final.
                feedback: async (source) =>
                    buildNewTaskFeedbackContent(
                        findLatestNewTaskFeedback({
                            apiHistory: perRequestHistory(await conversationView.read()),
                            uiHistory: messages.clineMessages,
                            approvedSource: source,
                        }),
                    ),
                start: (handoff) => options.prompt.ports.successor.start(options.taskId, handoff),
                onError: (error) =>
                    Logger.error(`[Task ${options.taskId}] Failed to start the New Task successor: ${String(error)}`),
            },
            // An approval is planned with the turn rather than opened by a tool, so
            // the interaction owner writes its row when the dialog is revealed.
            writeDialogAnchor: (request) => interactions.anchor(request),
            // A stop fences dialog admission, so a tool parked on its own request
            // can never be answered. The owner holds those receivers, so it is what
            // the stop releases.
            dialogWaiters: interactions,
            // Retained input may answer only after the reveal is durable and the
            // canonical interaction is awaiting a response.
            dialogAwaiting: interactions,
            providerPresentation,
            readMistakeLimit: () => ({
                count: toolState.consecutiveMistakeCount,
                limit: options.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes") ?? 3,
            }),
            // Every request records what it consumed, which is the only fact the
            // task has about context pressure, cache health and cost. The first one
            // also opens the baseline restore point the workspace can return to.
            providerRequestReport: new InitialCheckpointRequestReporter(
                new TaskPerformanceRequestReporter(
                    new TaskProviderRequestReporter({
                        // Compaction is the only consumer that acts on context pressure, and
                        // it can only learn it from the request that reported its usage.
                        pressure: compaction,
                        usage: contextUsage,
                        messages,
                        nextPresentationId,
                        api: () => api.current(),
                        promptCache,
                        compactTriggerOptions: readCompactTriggerOptions,
                        admittedRequest: () => contextWindowGuard.admittedRequest(),
                        // Retries happen before the stream says anything, so each attempt's
                        // card has to be delivered to the chat rather than left for the countdown.
                        // The state goes out immediately: a coalesced post would let the card's
                        // partial row reach a Webview that has not yet adopted this opening.
                        retryView: {
                            showRow: (row) => options.prompt.ports.presentation.publish(row),
                            publishState: () => options.publishState({ immediate: true }),
                        },
                        // Subscriptions report no token counts, so today's figures on the
                        // usage surfaces are counted here, against the Profile that served the request.
                        profileTokens: {
                            activeProfileId: () => activeProfile().profileId,
                            record: (profileId, increment) => {
                                void options.prompt.ports.profileUsage
                                    .record(profileId, increment)
                                    .catch((error) =>
                                        Logger.debug(
                                            `[Task ${options.taskId}] Failed to record daily Profile tokens: ${String(error)}`,
                                        ),
                                    )
                            },
                        },
                    }),
                    performance,
                ),
                {
                    checkpoints: tool.checkpoints,
                    hasRequested: () => messages.clineMessages.some((message) => message.say === "api_req_started"),
                },
            ),
            services: {
                // One sequence for both producers: chat rows are ordered by this id,
                // so the user's own row and the blocks it causes must be drawn from
                // the same counter to stay in causal order.
                provider: new DefaultProductionProviderService({
                    requests: providerRequests,
                    nextPresentationId,
                    resolveMcpServerName: (key) => tool.services.mcpHub.resolveServerName(key),
                    retry: providerRetry,
                    // Each ordinary request is one logical round for the rate metrics,
                    // however many transport attempts it takes to be answered.
                    rounds: performance,
                    serverTools: new HostedServerToolPresenter(options.taskId, messages, nextPresentationId, realtimeMessages),
                    // With auto-compaction on, the window is managed before a request
                    // is sent; with it off, a refusal for length is the first sign
                    // the conversation no longer fits, so the oldest history is dropped.
                    contextRecovery: {
                        enabled: () => options.stateManager.getGlobalSettingsKey("useAutoCondense") !== true,
                        truncate: async (signal) =>
                            session?.contextTruncation?.truncate({ notice: formatResponse.contextTruncationNotice(), signal }),
                    },
                    onRequestTiming: (timing) =>
                        Logger.debug(
                            formatApiRequestTiming({
                                taskId: options.taskId,
                                request: ++timedRequests,
                                timing,
                                activeTasks: options.prompt.ports.environment.activeTaskCount(),
                            }),
                        ),
                }),
                tool: new DefaultProductionToolExecutionService({
                    taskId: options.taskId,
                    config: toolExecution,
                    runtime: toolRuntime,
                    contextBudget,
                }),
                toolResources: {
                    revertDiff: async () => {
                        await tool.services.diffViewProvider.revertChanges()
                        await tool.services.diffViewProvider.reset()
                    },
                    cancelCommand: async () => {
                        await tool.commands.cancelTaskOwnedCommands()
                    },
                },
                toolOperationCancellation: {
                    cancel: (reason) => toolState.cancelOperations(reason),
                    reset: () => toolState.resetOperationCancellation(),
                },
                toolRoundCheckpoint: roundCheckpoints,
                toolSurface: tool.surface,
                toolScheduler: toolExecution.turnScheduler,
                environment,
                // A continued round has to say why it exists, and the wording
                // depends on how tools were offered for the current provider.
                continuation: new TurnContinuationRenderer({ usesNativeToolCalls }),
                // Compaction shares the ordinary request's frame, so the summary is
                // requested against the prefix the provider already cached.
                compaction: new ProviderCompactionService({
                    frames: providerRequests,
                    instruction: (frame, budgetGuidance) =>
                        renderCompactionInstruction({
                            cwd: options.cwd,
                            profile: frame.profile,
                            focusChain: options.stateManager.getGlobalSettingsKey("focusChainSettings"),
                            multiRoot: isMultiRootEnabled(options.stateManager),
                            budgetGuidance,
                        }),
                    triggerOptions: readCompactTriggerOptions,
                    requestPressures: () => collectContextWindowRequestPressures(messages.clineMessages),
                    scopes: compactionScopes,
                    progress: compactionCards,
                    environment,
                    indicator: {
                        passStarted: (compactionId, passIndex, attemptId, projection) =>
                            contextUsage.compactionPassStarted(compactionId, passIndex, attemptId, projection),
                        passProjected: (compactionId, projection) =>
                            contextUsage.compactionPassProjected(compactionId, projection),
                    },
                }),
                readApprovalPolicy: () => ({
                    settings: options.stateManager.getGlobalSettingsKey("autoApprovalSettings"),
                    blanket: {
                        yoloMode: options.stateManager.getGlobalSettingsKey("yoloModeToggled") === true,
                        approveAll: options.stateManager.getGlobalSettingsKey("autoApproveAllToggled") === true,
                    },
                }),
            },
            releases: [resources],
        })
        session = opened
        opened.bindBackgroundIngress(backgroundIngress)
        collaboration = new TaskCollaborationSessionOwner({
            runtime: options.prompt.ports.collaboration,
            taskId: options.taskId,
            taskIncarnationId,
            createdAt: options.collaboration.createdAt,
            kind: options.collaboration.kind,
            summary: options.collaboration.summary,
            state: () => opened.state(),
            ingress: opened.assembly.cotask,
            payloads: opened.payloads,
        })
        opened.bindCollaboration(collaboration)
        resources.add({
            release: async () => {
                await collaboration?.release()
            },
        })
        if (options.collaboration.writable) collaboration.activate()
        interactions.bind(session)
        return session
    }

    /**
     * The opened session, for collaborators composed before it exists.
     *
     * Composition is circular by nature: state reads and resume submissions are
     * wired into executors that the session itself owns. Failing loudly keeps that
     * ordering a defect rather than a silent no-op.
     */
    private requireSession(session: ActiveTaskSession | undefined): ActiveTaskSession {
        if (!session) throw new Error("Task session requested before composition completed")
        return session
    }

    /**
     * Build the admission this task uses for every submission.
     *
     * The catalog is the controller's, so the revision the Webview composed
     * against and the revision Core reviews against are the same fact. Lexing
     * waits for the first discovery, because a submission can arrive before any
     * consumer asked for the catalog and an undiscovered skill would otherwise
     * be demoted to plain text.
     */
    private composeInputAdmission(
        options: OpenTaskSessionCompositionOptions,
        taskIncarnationId: string,
        services: Awaited<ReturnType<TaskSessionHostFactory["create"]>>["services"],
        api: TaskApiHandlerOwner,
        settings: TaskStateManager,
    ): TaskSemanticInputAdmission {
        // Command expansion only reads the provider identity; the request scope is
        // the canonical way this composition derives it from the current handler.
        const readProviderInfo = () =>
            createRequestApiScope(
                api.current(),
                settings.mode,
                options.stateManager.getGlobalSettingsKey("customPrompt"),
                options.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true,
                undefined,
                options.stateManager.getCanonicalSettingsKey("imageGenerationEnabled") === true,
            ).providerInfo
        const service = () => options.prompt.ports.semanticCatalog
        const admission = new SemanticInputAdmissionService({
            catalog: () => service().current(),
            conflicts: () => service().conflicts(),
            // A resource node is admitted only when the task's store vouches for its bytes.
            resources: new StoreResourceVerifier(() => openTaskInputResources(options.taskId)),
            mentions: new TaskMentionResolver(() => ({
                cwd: options.cwd,
                urlContentFetcher: services.urlContentFetcher,
                fileContextTracker: services.fileContextTracker,
                workspaceManager: options.prompt.workspaceManager,
            })),
            commands: new TaskCommandExpander(() => {
                const toggles = options.prompt.readCapabilityToggles()
                const remoteConfig = options.stateManager.getRemoteConfigSettings()
                return {
                    localWorkflowToggles: toggles.localWorkflowToggles,
                    globalWorkflowToggles: toggles.globalWorkflowToggles,
                    taskIncarnationId,
                    focusChainSettings: options.stateManager.getGlobalSettingsKey("focusChainSettings"),
                    providerInfo: readProviderInfo(),
                    capabilityContext: {
                        cwd: options.cwd,
                        capabilityToggles: toggles,
                        remoteSkills: remoteConfig?.remoteGlobalSkills ?? [],
                        remoteWorkflows: remoteConfig?.remoteGlobalWorkflows ?? [],
                    },
                }
            }),
        })
        return new TaskSemanticInputAdmission(
            new LegacyInputAdapter(
                () => service().discovered(),
                () => `${options.taskId}:doc:${randomUUID()}`,
            ),
            admission,
        )
    }
}

/** How long closing a task waits for its running activities to acknowledge cancellation. */
const CLOSE_ACTIVITY_CANCEL_TIMEOUT_MS = 5_000

/**
 * End every activity still running when the session closes as cancelled.
 *
 * The store marks each activity before its canceller stops the work, so the
 * process kill that follows is not recorded as a command failure. Without this
 * a background command left running at close persisted as `failed` with the
 * kill signal as its error.
 */
export async function cancelRunningActivities(activities: TaskActivityStore): Promise<void> {
    const running = activities.listRunning().map((activity) => activity.activityId)
    if (running.length === 0) return
    await withTerminateTimeout(activities.cancel(running), CLOSE_ACTIVITY_CANCEL_TIMEOUT_MS, "cancelRunningActivities")
}
