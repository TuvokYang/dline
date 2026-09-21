import { randomUUID } from "node:crypto"
import type { Controller } from "@core/controller"
import { inputSemanticCatalogService } from "@core/controller/slash/input-semantic-catalog"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { LegacyInputAdapter } from "@core/input-semantics/LegacyInputAdapter"
import { SemanticInputAdmissionService } from "@core/input-semantics/SemanticInputAdmissionService"
import { TaskCommandExpander, TaskMentionResolver } from "@core/input-semantics/TaskEntityResolvers"
import { TaskSemanticInputAdmission } from "@core/input-semantics/TaskSemanticInputAdmission"
import type { StateManager } from "@core/storage/StateManager"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { McpHub } from "@services/mcp/McpHub"
import type { HistoryItem } from "@shared/HistoryItem"
import { Logger } from "@shared/services/Logger"
import type { TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import type { ApiConversation } from "../../storage/ApiConversation"
import type { UIMessage } from "../../storage/UIMessage"
import { TaskActivityPersistence } from "../activity/TaskActivityPersistence"
import { TaskActivityStore } from "../activity/TaskActivityStore"
import { DefaultProductionProviderService } from "../executors/provider/service/DefaultProductionProviderService"
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
import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import { TaskApiHandlerOwner } from "../session/TaskApiHandlerOwner"
import { TaskEnvironmentOwner } from "../session/TaskEnvironmentOwner"
import { TaskInputPresenter } from "../session/TaskInputPresenter"
import { TaskInteractionOwner } from "../session/TaskInteractionOwner"
import { TaskProviderRequestFactory } from "../session/TaskProviderRequestFactory"
import { openActiveTaskSession } from "../session/TaskSessionFactory"
import type { TaskSessionOwners } from "../session/TaskSessionOwners"
import { TaskToolExecutionOwner } from "../session/TaskToolExecutionOwner"
import { openTaskPersistence } from "../shell/TaskPersistenceAssembly"
import type { TaskViewPort } from "../stores"
import { TaskStateManager } from "../TaskStateManager"
import { DefaultToolHandlerState } from "../tools/state/ToolHandlerState"
import { ToolValidator } from "../tools/ToolValidator"
import type { TaskSessionHostFactory } from "./TaskSessionHostFactory"

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
		const taskIncarnationId = options.taskIncarnationId ?? randomUUID()
		const persistence = await openTaskPersistence(options.taskId)
		const settings = new TaskStateManager(options.taskId, options.stateManager)
		const toolState = new DefaultToolHandlerState()
		const messages = new MessageStateHandler({
			taskId: options.taskId,
			ulid: taskIncarnationId,
			taskIsFavorited: options.messages.taskIsFavorited,
			updateTaskHistory: options.messages.updateTaskHistory,
			publishTaskHistoryClose: options.messages.publishTaskHistoryClose,
			metadata: toolState,
			uiMessage: options.messages.uiMessage,
			apiConversation: options.messages.apiConversation,
		})
		const activities = new TaskActivityStore(options.taskId, new TaskActivityPersistence(options.taskId))
		await activities.hydrate()
		const interactions = new TaskInteractionOwner(messages, persistence.payloads)
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
		let session: ActiveTaskSession | undefined
		const readState = (): Readonly<TaskState> => {
			if (!session) throw new Error("Task session state requested before composition completed")
			return session.state()
		}
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
		const providerRequests = new TaskProviderRequestFactory({
			taskId: options.taskId,
			stateManager: options.stateManager,
			settings,
			api,
			promptContext,
			prompt,
			messages: new ProviderJournalMessageMaterializer(persistence.payloads),
			authority: turnAuthority,
			tools: toolRuntime,
			readAdmissionSnapshot: (block) => toolExecution.readAdmissionSnapshot(block),
		})
		const owners: TaskSessionOwners = {
			identity: { taskId: options.taskId, taskIncarnationId },
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
		const opened = await openActiveTaskSession({
			taskId: options.taskId,
			openReason: options.openReason,
			persistence,
			taskView: options.taskView,
			owners,
			inputAdmission: this.composeInputAdmission(options, taskIncarnationId, tool.services, api, settings),
			inputPresentation: new TaskInputPresenter(persistence.payloads, messages),
			services: {
				provider: new DefaultProductionProviderService({ requests: providerRequests }),
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
				compaction: tool.compaction,
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
				{ release: () => prompt.dispose() },
				{
					release: async () => {
						await activities.waitForPersistence()
						activities.dispose()
					},
				},
				{ release: () => tool.browser.dispose() },
				{ release: () => tool.commands.dispose() },
				...(tool.releases ?? []),
				{ release: async () => interactions.dispose() },
			],
		})
		if (opened.kind === "read_only") throw new Error(`TaskReadOnly:${opened.reason}`)
		session = opened.session
		interactions.bind(session)
		return session
	}

	/**
	 * Build the admission this task uses for every submission.
	 *
	 * The catalog is the controller's, so the revision the Webview composed
	 * against and the revision Core reviews against are the same fact.
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
		const catalog = () => inputSemanticCatalogService(options.prompt.controller).current()
		const admission = new SemanticInputAdmissionService({
			catalog,
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
			new LegacyInputAdapter(catalog, () => `${options.taskId}:doc:${randomUUID()}`),
			admission,
		)
	}
}
