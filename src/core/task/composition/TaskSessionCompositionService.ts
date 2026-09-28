import { randomUUID } from "node:crypto"
import { getContextWindowInfo } from "@core/context/context-management/context-window-utils"
import type { Controller } from "@core/controller"
import { inputSemanticCatalogService } from "@core/controller/slash/input-semantic-catalog"
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { LegacyInputAdapter } from "@core/input-semantics/LegacyInputAdapter"
import { SemanticInputAdmissionService } from "@core/input-semantics/SemanticInputAdmissionService"
import { TaskCommandExpander, TaskMentionResolver } from "@core/input-semantics/TaskEntityResolvers"
import { TaskSemanticInputAdmission } from "@core/input-semantics/TaskSemanticInputAdmission"
import type { StateManager } from "@core/storage/StateManager"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { McpHub } from "@services/mcp/McpHub"
import type { HistoryItem } from "@shared/HistoryItem"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Logger } from "@shared/services/Logger"
import type { TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import type { ApiConversation } from "../../storage/ApiConversation"
import type { UIMessage } from "../../storage/UIMessage"
import { TaskActivityPersistence } from "../activity/TaskActivityPersistence"
import { TaskActivityStore } from "../activity/TaskActivityStore"
import { renderCompactionInstruction } from "../compaction/CompactionInstruction"
import { CompactionRequestScopes } from "../compaction/CompactionRequestScopes"
import { CompactionRoundBarrier } from "../compaction/CompactionRoundBarrier"
import { InteractionCompactionReview } from "../compaction/InteractionCompactionReview"
import { MessageStateCompactionFailure } from "../compaction/MessageStateCompactionFailure"
import { MessageStateCompactionLanding } from "../compaction/MessageStateCompactionLanding"
import { ProviderCompactionService } from "../compaction/ProviderCompactionService"
import { importLegacyConversation } from "../conversation/LegacyConversationImport"
import { DefaultProductionProviderService } from "../executors/provider/service/DefaultProductionProviderService"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import { DefaultProductionToolExecutionService } from "../executors/tool/production/DefaultProductionToolExecutionService"
import { ProductionToolHandlerRuntime } from "../executors/tool/production/ProductionToolHandlerRuntime"
import { TaskTurnAuthority } from "../explicit-instructions/TurnAuthority"
import type { TaskState } from "../kernel"
import { MessageStateHandler } from "../message-state"
import { TaskPromptContextOwner } from "../prompt/TaskPromptContextOwner"
import { TaskPromptLifecycle } from "../prompt/TaskPromptLifecycle"
import { PromptCacheHealthTracker } from "../prompt-cache/PromptCacheHealthTracker"
import { createRequestApiScope } from "../RequestApiScope"
import { LoggingRuntimeDiagnostics } from "../runtime"
import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import { createPresentationIdSequence } from "../session/PresentationIdSequence"
import { ProviderTextPresenter } from "../session/ProviderTextPresenter"
import { readRestoredContextPressure } from "../session/RestoredContextPressure"
import { RestoredToolDialogContinuation } from "../session/RestoredToolDialogContinuation"
import { TaskApiHandlerOwner } from "../session/TaskApiHandlerOwner"
import { TaskBackgroundResultsOwner } from "../session/TaskBackgroundResultsOwner"
import { TaskContextUsageProjection } from "../session/TaskContextUsageProjection"
import { TaskEnvironmentOwner } from "../session/TaskEnvironmentOwner"
import { TaskInputPresenter } from "../session/TaskInputPresenter"
import { TaskInteractionOwner } from "../session/TaskInteractionOwner"
import { TaskProviderRequestFactory } from "../session/TaskProviderRequestFactory"
import { resolveCompactTriggerTokens, TaskProviderRequestReporter } from "../session/TaskProviderRequestReporter"
import { openActiveTaskSession } from "../session/TaskSessionFactory"
import type { TaskSessionOwners } from "../session/TaskSessionOwners"
import { TaskToolExecutionOwner } from "../session/TaskToolExecutionOwner"
import { TurnContinuationRenderer } from "../session/TurnContinuationRenderer"
import {
	ResumeDialogContinuation,
	type TaskResumptionPort as ResumeDialogContinuationPorts,
} from "../session/UnownedDialogContinuation"
import { openTaskPersistence, type TaskPersistenceAssembly } from "../shell/TaskPersistenceAssembly"
import type { TaskViewPort } from "../stores"
import { JournalConversationRewind } from "../stores/JournalConversationRewind"
import { TaskStateManager } from "../TaskStateManager"
import { DefaultToolHandlerState } from "../tools/state/ToolHandlerState"
import { ToolValidator } from "../tools/ToolValidator"
import type { TaskSessionHostFactory } from "./TaskSessionHostFactory"

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
	readonly updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	readonly publishTaskHistoryClose?: () => void
}

export interface TaskSessionPromptHost {
	readonly controller: Controller
	readonly mcpHub: McpHub
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
	readonly publishState: () => Promise<void>
}

/** The only production composition root for one task incarnation. */
export class TaskSessionCompositionService {
	async open(options: OpenTaskSessionCompositionOptions): Promise<ActiveTaskSession> {
		let persistence: TaskPersistenceAssembly | undefined
		try {
			persistence = await openTaskPersistence(options.taskId)
			return await this.compose(options, persistence)
		} catch (error) {
			// Nothing owns the task yet, so its journal.db and messages.db writers
			// would otherwise stay claimed. Closing must not replace the failure.
			await Promise.allSettled([
				persistence?.close?.(),
				options.messages.uiMessage.close(),
				options.messages.apiConversation.close(),
			])
			throw error
		}
	}

	private async compose(
		options: OpenTaskSessionCompositionOptions,
		persistence: TaskPersistenceAssembly,
	): Promise<ActiveTaskSession> {
		const taskIncarnationId = options.taskIncarnationId ?? randomUUID()
		// Before the kernel reads the journal tail, so a task from an older build
		// hydrates with the conversation it already had.
		if (!options.deferRestoredCommands) await this.importLegacyConversation(options, persistence)
		const settings = new TaskStateManager(options.taskId, options.stateManager)
		const toolState = new DefaultToolHandlerState()
		// One view per task: requests, compaction and every conversation reader
		// share it, and each journal payload is rendered once rather than once per round.
		const journalMessages = new ProviderJournalMessageMaterializer(persistence.payloads)
		const conversationView = new JournalConversationView(persistence.ports.journal, journalMessages)
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
		const activities = new TaskActivityStore(options.taskId, activityPersistence)
		await activities.hydrate()
		let session: ActiveTaskSession | undefined
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
			submit: (input) => this.requireSession(session).task.submitInput(input),
		}
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
					publishRow: (row) => sendPartialMessageEvent(options.prompt.controller, convertClineMessageToProto(row)),
				},
				resumption,
				new ResumeDialogContinuation(resumption),
			),
			diagnostics,
		)
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
		const promptContext = new TaskPromptContextOwner({
			identity: { taskId: options.taskId, cwd: options.cwd },
			controller: options.prompt.controller,
			mcpHub: options.prompt.mcpHub,
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
		prompt.start()
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
			readState,
			// A chat restore undoes what was said after the restored row in the
			// conversation the provider is sent, which only this task's journal holds.
			conversationRewind: new JournalConversationRewind(persistence.ports.journal, conversationView),
		})
		const toolRuntime = new ProductionToolHandlerRuntime(new ToolValidator(options.prompt.ignoreController))
		// One owner per task session: the provider request grants the turn's
		// authority and the tool gate reads it back under the same turn identity.
		const turnAuthority = new TaskTurnAuthority()
		const toolExecution = new TaskToolExecutionOwner({
			taskId: options.taskId,
			taskIncarnationId,
			cwd: options.cwd,
			toolRuntime,
			stateManager: options.stateManager,
			settings,
			messages,
			activities,
			api,
			toolState,
			services: tool.services,
			interactions,
			callbacks: tool.callbacks,
			readState,
			readCapabilityToggles: options.prompt.readCapabilityToggles,
			readTurnAuthority: (turnId) => turnAuthority.read(turnId),
			workspaceManager: options.prompt.workspaceManager,
			providerRequestRounds: tool.providerRequestRounds,
			controllerContext: tool.controllerContext,
			terminalExecutionMode: options.prompt.terminalExecutionMode,
		})
		const environment = tool.terminals
			? new TaskEnvironmentOwner({
					taskId: options.taskId,
					cwd: options.cwd,
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
				})
			: undefined
		// Background work outlives the round that started it, so its results
		// need a later round to carry them; without this the model never learns
		// what a backgrounded command or subagent produced.
		const backgroundResults = new TaskBackgroundResultsOwner({ subagents: toolExecution, commands: tool.commands })
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
		})
		const nextPresentationId = createPresentationIdSequence()
		const compactionScopes = new CompactionRequestScopes()
		const owners: TaskSessionOwners = {
			identity: { taskId: options.taskId, taskIncarnationId },
			nextPresentationId,
			compactionScopes,
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
			inputQueue: tool.inputQueue,
			apiRateSnapshot: tool.apiRateSnapshot,
			queryRateMetrics: tool.queryRateMetrics,
		}
		// The whole auto-condense setting group defines the trigger and the window a
		// compaction may use. Passing only the percent would silently ignore the
		// reserve bounds and the absolute cap the user configured.
		const readCompactTriggerOptions = () => ({
			triggerPercent: options.stateManager.getGlobalSettingsKey("autoCondenseTriggerPercent"),
			minReserveTokens: options.stateManager.getGlobalSettingsKey("autoCondenseMinReserveTokens"),
			maxReserveTokens: options.stateManager.getGlobalSettingsKey("autoCondenseMaxReserveTokens"),
			maxContextTokens: options.stateManager.getGlobalSettingsKey("autoCondenseMaxContextTokens"),
		})
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
		// The pressure a settled request reported lives in memory, so a task
		// reopened by a chat restore would send one uncompacted request before
		// noticing that the rewound conversation is still full. Only a restore
		// seeds it: an ordinary resume keeps the conversation it already fitted.
		if (options.openReason === "checkpoint_restore") {
			const trigger = resolveCompactTriggerTokens(getContextWindowInfo(api.current()).contextWindow, {
				triggerPercent: options.stateManager.getGlobalSettingsKey("autoCondenseTriggerPercent"),
				minReserveTokens: options.stateManager.getGlobalSettingsKey("autoCondenseMinReserveTokens"),
				maxReserveTokens: options.stateManager.getGlobalSettingsKey("autoCondenseMaxReserveTokens"),
				maxContextTokens: options.stateManager.getGlobalSettingsKey("autoCondenseMaxContextTokens"),
			})
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
		})
		// Every Mode, Profile, or configuration switch ends in a handler rebuild,
		// and the header must then describe the scope the task runs under.
		api.onRebuilt(() => contextUsage.rebound())
		const opened = await openActiveTaskSession({
			taskId: options.taskId,
			openReason: options.openReason,
			deferRestoredCommands: options.deferRestoredCommands,
			persistence,
			conversationView,
			// A request's figure stays in flight until the run it belongs to comes
			// to rest, and only a committed state says when that is.
			taskView: {
				notifyCommitted: async (state) => {
					// Applied first and synchronously, so the view it informs never
					// delays the figure and a failing view cannot skip it.
					contextUsage.committed(state)
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
			// A round that would overflow the window waits for the summary first,
			// so the request it sends is the one that fits. It guards compose
			// rather than submission because the kernel also opens rounds on its
			// own, and those must not skip the barrier.
			compactionBarrier: compaction,
			// The barrier releases when the whole run ends, so it observes the
			// executor port rather than the provider call inside it.
			compactionSettlement: compaction,
			// A summary only shrinks the context once it replaces the history it
			// summarized and is shown as the card the user can restore from.
			compactionLanding: new MessageStateCompactionLanding(messages, nextPresentationId),
			// A summary the user asked for is theirs to accept or regenerate before
			// it replaces the conversation, through the same dialog every task uses.
			compactionReview: new InteractionCompactionReview(interactions),
			// A run that produced nothing left the conversation as it was, which the
			// user cannot see unless the chat says so.
			compactionFailure: new MessageStateCompactionFailure(messages, nextPresentationId),
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
				start: async (handoff) => {
					await options.prompt.controller.startSuccessorTask(
						options.taskId,
						handoff.context,
						handoff.taskSettings,
						handoff.initialUserContent,
					)
				},
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
			// A reply that calls no tool has no block to render it, so the prose
			// itself is what the chat must show.
			providerPresentation: new ProviderTextPresenter(messages, nextPresentationId),
			// Every request records what it consumed, which is the only fact the
			// task has about context pressure, cache health and cost.
			providerRequestReport: new TaskProviderRequestReporter({
				// Compaction is the only consumer that acts on context pressure, and
				// it can only learn it from the request that reported its usage.
				pressure: compaction,
				usage: contextUsage,
				messages,
				nextPresentationId,
				api: () => api.current(),
				promptCache,
				compactTriggerOptions: readCompactTriggerOptions,
				// Retries happen before the stream says anything, so each attempt's
				// card has to be delivered to the chat rather than left for the countdown.
				retryView: {
					showRow: (row) => sendPartialMessageEvent(options.prompt.controller, convertClineMessageToProto(row)),
					publishState: options.publishState,
				},
				// Subscriptions report no token counts, so today's figures on the
				// usage surfaces are counted here, against the Profile that served the request.
				profileTokens: {
					activeProfileId: () => activeProfile().profileId,
					record: (profileId, increment) => {
						void options.prompt.controller
							.recordProfileTokenUsage(profileId, increment)
							.catch((error) =>
								Logger.debug(`[Task ${options.taskId}] Failed to record daily Profile tokens: ${String(error)}`),
							)
					},
				},
			}),
			services: {
				// One sequence for both producers: chat rows are ordered by this id,
				// so the user's own row and the blocks it causes must be drawn from
				// the same counter to stay in causal order.
				provider: new DefaultProductionProviderService({ requests: providerRequests, nextPresentationId }),
				tool: new DefaultProductionToolExecutionService({ config: toolExecution, runtime: toolRuntime }),
				toolResources: {
					revertDiff: async () => {
						await tool.services.diffViewProvider.revertChanges()
						await tool.services.diffViewProvider.reset()
					},
					cancelCommand: async () => {
						await tool.commands.cancelTaskOwnedCommands()
					},
				},
				toolSurface: tool.surface,
				toolScheduler: toolExecution.turnScheduler,
				environment,
				backgroundResults,
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
					scopes: compactionScopes,
				}),
				readApprovalPolicy: () => ({
					settings: options.stateManager.getGlobalSettingsKey("autoApprovalSettings"),
					blanket: {
						yoloMode: options.stateManager.getGlobalSettingsKey("yoloModeToggled") === true,
						approveAll: options.stateManager.getGlobalSettingsKey("autoApproveAllToggled") === true,
					},
				}),
				spawn: tool.spawn,
			},
			releases: [
				// Released last: every other owner may still commit while it shuts down.
				{ release: async () => persistence.close?.() },
				// Closing is the durability boundary of the chat rows and releases the
				// single messages.db writer, so the task can be opened again in this
				// window. Released after every owner that may still record a row.
				{ release: () => messages.close() },
				{ release: () => prompt.dispose() },
				{
					release: async () => {
						await activities.waitForPersistence()
						activities.dispose()
						// activities.db has one writer; closing releases it for the next session.
						await activityPersistence.close()
					},
				},
				{ release: () => tool.browser.dispose() },
				{ release: () => tool.commands.dispose() },
				...(tool.releases ?? []),
				{ release: async () => interactions.dispose() },
			],
		})
		session = opened
		interactions.bind(session)
		return session
	}

	/**
	 * Carry a pre-journal conversation into the journal.
	 *
	 * Only the window owning the task lock writes `journal.db`, so a window
	 * that opens the task read-only leaves it to the owner. A failed import is
	 * logged and the task still opens: the import resumes on the next open, and
	 * refusing the task would lose more than the missing context.
	 */
	private async importLegacyConversation(
		options: OpenTaskSessionCompositionOptions,
		persistence: TaskPersistenceAssembly,
	): Promise<void> {
		try {
			const imported = await importLegacyConversation({
				journal: persistence.ports.journal,
				payloads: persistence.payloads,
				legacy: options.messages.apiConversation.getAll(),
			})
			if (imported > 0) Logger.info(`[Task ${options.taskId}] Imported ${imported} legacy conversation messages`)
		} catch (error) {
			Logger.warn(`[Task ${options.taskId}] Legacy conversation import failed; it resumes on the next open`, error)
		}
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
		const service = () => inputSemanticCatalogService(options.prompt.controller)
		const admission = new SemanticInputAdmissionService({
			catalog: () => service().current(),
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
