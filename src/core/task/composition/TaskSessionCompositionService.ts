import { randomUUID } from "node:crypto"
import type { ToolUse } from "@core/assistant-message"
import { collectContextWindowRequestPressures } from "@core/context/context-management/context-pressure"
import { getContextWindowInfo } from "@core/context/context-management/context-window-utils"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import type { InputResourceStore } from "@core/input-semantics/InputResourceStore"
import { LegacyInputAdapter } from "@core/input-semantics/LegacyInputAdapter"
import { SemanticInputAdmissionService } from "@core/input-semantics/SemanticInputAdmissionService"
import { StoreDraftAttachments } from "@core/input-semantics/StoreDraftAttachments"
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
import { type CommandRowSurface, settleInterruptedCommandRows } from "../activity/interruptedCommandRows"
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
import { approvalPolicySnapshotOf } from "../executors/policy/ProductionApprovalPolicyAdapter"
import { DefaultProductionProviderService } from "../executors/provider/service/DefaultProductionProviderService"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import { ProviderRetryGate } from "../executors/provider/service/ProviderRetryGate"
import { DefaultProductionToolExecutionService } from "../executors/tool/production/DefaultProductionToolExecutionService"
import { ProductionToolHandlerRuntime } from "../executors/tool/production/ProductionToolHandlerRuntime"
import { InMemoryToolApprovalFeedbackLedger } from "../executors/tool/ToolApprovalFeedbackLedger"
import { TaskTurnAuthority } from "../explicit-instructions/TurnAuthority"
import type { TaskCompletionProjection, TaskCompletionProjectionUpdate } from "../history/TaskCompletionProjector"
import { TaskCompletionProjector } from "../history/TaskCompletionProjector"
import type { TaskState } from "../kernel"
import { MessageStateHandler } from "../message-state"
import { createSuccessorHandoffPublisher, type TaskSuccessorPort } from "../new-task/successor-handoff"
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
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { ToolInvocationEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { TaskStateManager } from "../TaskStateManager"
import { withTerminateTimeout } from "../TaskTerminateTimeout"
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
        // One store serves every reader of the task's input resources: requests
        // read verified bytes by reference, admission vouches for a node's bytes,
        // and a dialog receiver resolves its draft's attachments from it.
        const inputResources = openTaskInputResources(options.taskId)
        const journalMessages = new ProviderJournalMessageMaterializer(persistence.payloads, inputResources)
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
        // Only the window holding the task lock may write. A deferred opening may
        // be showing work another window still runs, so it settles nothing.
        const ownsTask = !options.deferRestoredCommands
        let activityMaintenanceStarted = false
        let activityMaintenance: Promise<void> = Promise.resolve()
        const runActivityMaintenance = async () => {
            await activities.hydrate()
            // Commands and subagents are owned by the session that started them
            // and end with it, so persisted in-flight work is now ownerless.
            if (ownsTask) await settleOrphanedActivities(activities, messages)
        }
        const startActivityMaintenance = (defer = true) => {
            if (activityMaintenanceStarted) return
            activityMaintenanceStarted = true
            // Large activity histories contain bounded command/subagent payloads that
            // are irrelevant to request admission. Yield once after the provider wire
            // starts, then hydrate and recover them under the normal single-writer store.
            activityMaintenance = (
                defer
                    ? new Promise<void>((resolve) => setImmediate(resolve)).then(runActivityMaintenance)
                    : runActivityMaintenance()
            ).catch((error: unknown) =>
                Logger.warn(
                    `[TaskSessionComposition] ${options.taskId}: deferred activity maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
            )
        }
        let activityRelease: Promise<void> | undefined
        const activityResource = {
            release: () => {
                activityRelease ??= (async () => {
                    // A task that closes before its first provider request still drains
                    // the same durable recovery before relinquishing activities.db.
                    startActivityMaintenance(false)
                    await activityMaintenance
                    try {
                        // Released after the command and subagent owners, so nothing is
                        // left that could still finish an activity in flight. The chat
                        // store closes after this resource, so its rows can still be settled.
                        if (ownsTask) await settleClosedActivities(activities, messages)
                        await activities.waitForPersistence()
                    } finally {
                        activities.dispose()
                    }
                })()
                return activityRelease
            },
        }
        // Early fallback for failures before host resources have been acquired.
        resources.add(activityResource)
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
            materialize: (input) => this.requireSession(session).inputs.materialize(input),
            materializeAnswer: (input) => this.requireSession(session).inputs.materializeAnswer(input),
            submit: (input) => this.requireSession(session).task.submitInput(input),
        }
        // The footer shows Retry and Cancel only while a countdown owns the
        // request, so every change of that ownership republishes the view. A
        // Retry answered on a failed request hands that request to the user.
        const providerRetry = new ProviderRetryGate(() => void options.publishState().catch(() => undefined))
        // Numbers the requests this session timed, for the diagnostic line each one logs.
        let timedRequests = 0
        // A `new_task` hands the conversation to a successor on the same
        // surface. The Controller owns that surface, so it starts the successor
        // once the runtime has durably marked this task consumed.
        const successor: TaskSuccessorPort = {
            settings: () => ({
                mode: settings.mode,
                planModeProfileId: settings.planModeProfileId,
                planModeProfile: settings.planModeProfile,
                actModeProfileId: settings.actModeProfileId,
                actModeProfile: settings.actModeProfile,
            }),
            start: (handoff) => options.prompt.ports.successor.start(options.taskId, handoff),
            onError: (error) => Logger.error(`[Task ${options.taskId}] Failed to start the New Task successor: ${String(error)}`),
        }
        // One publisher for the live tool adapter and a restored dialog, so a
        // `new_task` approved either way records its result and hands off alike.
        const postCommit = createSuccessorHandoffPublisher({
            runtime: () => this.requireSession(session).assembly.runtime,
            successor,
        })
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
                    publishPostCommit: postCommit,
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
        let performance: TaskPerformanceOwner | undefined
        const taskTelemetry = new TaskTurnTelemetry(
            options.taskId,
            readState,
            () => performance?.getSnapshot() ?? { cacheUsageAvailable: false },
            (input) => performance?.providerAttemptObserver(input),
            (state) => performance?.committed(state, isRunAtRest(state)),
            (input) => performance?.providerAttemptUsage(input),
            (input) => performance?.providerRequestCompleted(input),
        )
        taskTelemetry.registerAlias(taskIncarnationId)
        resources.add({ release: async () => taskTelemetry.dispose() })
        performance = await TaskPerformanceOwner.open({
            taskId: options.taskId,
            readState,
            legacyMessages: () => messages.clineMessages,
            onChanged: () => void options.publishState().catch(() => undefined),
            finalizedAttempts: taskTelemetry,
            readUsagePolicyGeneration: () => taskTelemetry.usagePolicyGeneration(),
            projectUsageModelId: (provider, wireModelId) => taskTelemetry.projectUsageModelId(provider, wireModelId),
            // Usage reports which tool each settled call ran. The kernel keeps the
            // call, not its tool, so the name comes from the stored invocation.
            resolveInvocationToolName: async (invocationRef) => {
                const envelope = decodeTaskPayload<ToolInvocationEnvelope>(await persistence.payloads.read(invocationRef))
                return envelope.kind === "tool_invocation" ? envelope.toolName : undefined
            },
        })
        resources.add({ release: () => performance?.release() })
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
        // If host creation fails, activity recovery must run before the already
        // acquired presentation owners release the message surface it patches.
        resources.add(activityResource)
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
            // The checklist a task accepts here is the authoritative TODO history,
            // so usage observes it at the source instead of re-reading tool args.
            observeChecklist: (changes) => performance.observeChecklist(changes),
            checkpoints: {
                capture: async (input) => {
                    // A pre-edit row restores the conversation of its round row: that
                    // row's stored state and position, with this row's files.
                    const anchor =
                        input.anchorTs === undefined
                            ? undefined
                            : await checkpointRepository
                                  .resolve(canonicalCheckpointRef(options.taskId, input.anchorTs))
                                  .catch(() => undefined)
                    // The runtime state, not the vault's coalesced snapshot, which can lag
                    // the conversation position the row recorded.
                    const snapshot = anchor?.snapshot ?? (input.boundary ? { state: readState(), outbox: [] } : undefined)
                    const boundary = anchor?.boundary ?? input.boundary
                    await checkpointRepository.capture({
                        checkpointRef: canonicalCheckpointRef(options.taskId, input.messageTs),
                        ...(input.workspaceRef === undefined ? {} : { workspaceRef: input.workspaceRef }),
                        ...(snapshot === undefined ? {} : { snapshot }),
                        ...(boundary === undefined ? {} : { boundary }),
                    })
                },
                advancedSince: async (seq) => {
                    const entries = await persistence.ports.journal.read({ seq })
                    return entries.some((entry) => entry.kind !== "checkpoint_marker")
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
                            resolve: async () => {
                                if (input.journalTarget) return checkpointRepository.resolveAt(input.journalTarget)
                                try {
                                    return await checkpointRepository.resolve(checkpointRef)
                                } catch (error) {
                                    // A row whose capture failed is still restorable from the
                                    // position it recorded and the files it holds.
                                    const missing = error instanceof Error && error.message === "CanonicalCheckpointNotFound"
                                    if (!missing || !input.fallback) throw error
                                    const record = await checkpointRepository.resolveAt(input.fallback.journalTarget)
                                    return input.fallback.workspaceRef === undefined
                                        ? record
                                        : { ...record, workspaceRef: input.fallback.workspaceRef }
                                }
                            },
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
        // Re-register the same idempotent fence after host owners so reverse-order
        // teardown settles command rows before those owners release their surfaces.
        resources.add(activityResource)
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
        const approvalFeedback = new InMemoryToolApprovalFeedbackLedger()
        const toolRuntime = new ProductionToolHandlerRuntime(new ToolValidator(options.prompt.ignoreController))
        // One owner per task session: the provider request grants the turn's
        // authority and the tool gate reads it back under the same turn identity.
        const turnAuthority = new TaskTurnAuthority()
        const toolExecution = new TaskToolExecutionOwner({
            taskId: options.taskId,
            taskIncarnationId,
            cwd: options.cwd,
            toolRuntime,
            approvalFeedback,
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
            callbacks: tool.callbacks,
            readState,
            readCapabilityToggles: options.prompt.readCapabilityToggles,
            readTurnAuthority: (turnId) => turnAuthority.read(turnId),
            workspaceManager: options.prompt.workspaceManager,
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
            approvalFeedback,
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
            inputAdmission: this.composeInputAdmission(options, taskIncarnationId, tool.services, api, settings, inputResources),
            draftAttachments: new StoreDraftAttachments(() => inputResources),
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
                new ContextUsageCompactionLanding({
                    frames: providerRequests,
                    conversation: providerConversation,
                    usage: contextUsage,
                }),
                new PromptStateCompactionLanding(prompt, promptCache),
                // Results that waited for room are delivered once the summary freed it.
                { land: () => backgroundIngress.releaseHeld() },
                // The durable completed card is last: an earlier post-commit projection
                // failure must not leave a card for a run the executor records as failed.
                new MessageStateCompactionLanding(compactionCards),
            ]),
            // A summary the user asked for is theirs to accept or regenerate before
            // it replaces the conversation, through the same dialog every task uses.
            // The barrier says when it may open, so it never takes the slot from a
            // round that can still end on a dialog of its own.
            compactionReview: new InteractionCompactionReview(interactions, compaction),
            compactionFailure,
            compactionProgress: compactionCards,
            postCommit,
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
            // Every request and every compaction opens a round, and the round's
            // restore point is written first: its row lands before the request's
            // own, holding the workspace and conversation the model is about to see.
            providerCheckpoint: tool.checkpoints && {
                beforeRequest: (turnId, signal) =>
                    tool.checkpoints?.ensureRoundCheckpoint?.("round_start", { kind: "round_start", turnId }, signal) ??
                    Promise.resolve(),
            },
            providerLifecycle: {
                afterProviderStarted: () => {
                    tool.checkpoints?.startWorkspaceWatcher?.()
                    startActivityMaintenance()
                },
            },
            compactionCheckpoint: tool.checkpoints && {
                beforeCompaction: (signal) =>
                    tool.checkpoints?.prepareCompactionRestore?.(signal) ?? Promise.resolve("card_fallback"),
            },
            // Every request records what it consumed, which is the only fact the
            // task has about context pressure, cache health and cost.
            providerRequestReport: new TaskPerformanceRequestReporter(
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
            services: {
                // One sequence for both producers: chat rows are ordered by this id,
                // so the user's own row and the blocks it causes must be drawn from
                // the same counter to stay in causal order.
                provider: new DefaultProductionProviderService({
                    requests: providerRequests,
                    nextPresentationId,
                    resolveMcpTool: (serverKey, toolSegment) => tool.services.mcpHub.resolveNativeTool(serverKey, toolSegment),
                    retry: providerRetry,
                    serverTools: new HostedServerToolPresenter(options.taskId, messages, nextPresentationId, realtimeMessages),
                    // A refusal for length means the request no longer fits, whether or
                    // not auto-compaction sized it beforehand, so the oldest history is
                    // dropped and the request resent rather than surfaced to the user.
                    contextRecovery: {
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
                readApprovalPolicy: () =>
                    approvalPolicySnapshotOf(options.stateManager.getGlobalSettingsKey("autoApprovalSettings"), {
                        yoloMode: options.stateManager.getGlobalSettingsKey("yoloModeToggled") === true,
                        approveAll: options.stateManager.getGlobalSettingsKey("autoApproveAllToggled") === true,
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
        inputResources: InputResourceStore,
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
            resources: new StoreResourceVerifier(() => inputResources),
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
                () => service().current(),
            ),
            admission,
        )
    }
}

/**
 * Settle activities persisted as in flight by an earlier session, and their command rows.
 *
 * Failures are logged rather than thrown: an unsettled row is a stale display,
 * and must not keep the task from opening.
 */
async function settleOrphanedActivities(activities: TaskActivityStore, messages: CommandRowSurface): Promise<void> {
    try {
        const interrupted = new Set(await activities.recoverInterruptedActivities())
        await settleInterruptedCommandRows(messages, interrupted)
    } catch (error) {
        Logger.warn(
            `[TaskSessionComposition] ${activities.taskId}: could not settle orphaned activities: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

/**
 * Settle activities still in flight when the session closes, and their command rows.
 *
 * The next opening recovers only activities persisted as in flight, so a row
 * left running here would stay running after its activity was settled.
 * Failures are logged rather than thrown so the rest of the release still runs.
 */
async function settleClosedActivities(activities: TaskActivityStore, messages: CommandRowSurface): Promise<void> {
    try {
        const interrupted = new Set(activities.interruptUnsettledActivities())
        await settleInterruptedCommandRows(messages, interrupted)
    } catch (error) {
        Logger.warn(
            `[TaskSessionComposition] ${activities.taskId}: could not settle activities on close: ${error instanceof Error ? error.message : String(error)}`,
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
