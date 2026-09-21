import { ContextManager } from "@core/context/context-management/ContextManager"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { Controller } from "@core/controller"
import { createImageGenerationRuntime } from "@core/image-generation/runtime"
import { CommandPermissionController } from "@core/permissions/CommandPermissionController"
import { ensureTaskDirectoryExists } from "@core/storage/disk"
import type { StateManager } from "@core/storage/StateManager"
import type {
	TaskSessionHostContext,
	TaskSessionHostFactory,
	TaskSessionHostResources,
} from "@core/task/composition/TaskSessionHostFactory"
import type { ToolDomainSurface } from "@core/task/executors/tool/ToolDomainSurface"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import type { CommandExecutorCallbacks } from "@integrations/terminal/types"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import type { McpHub } from "@services/mcp/McpHub"
import type { ClineExtensionContext } from "@shared/cline/context"
import { HostProvider } from "@/hosts/host-provider"
import { ControllerTaskCallbacksOwner } from "./ControllerTaskCallbacksOwner"
import { ControllerTaskCheckpointOwner } from "./ControllerTaskCheckpointOwner"
import { ControllerTaskCompactionService } from "./ControllerTaskCompactionService"
import { ControllerTaskSpawnLauncher } from "./ControllerTaskSpawnLauncher"

export interface ControllerTaskSessionHostFactoryOptions {
	readonly controller: Controller
	readonly context: ClineExtensionContext
	readonly stateManager: StateManager
	readonly mcpHub: McpHub
	readonly ignoreController: TaskSessionHostResources["services"]["ignoreController"]
	readonly workspaceManager?: WorkspaceRootManager
}

/** Produces host-owned resources after canonical task owners have been created. */
export class ControllerTaskSessionHostFactory implements TaskSessionHostFactory {
	constructor(private readonly options: ControllerTaskSessionHostFactoryOptions) {}

	async create(context: TaskSessionHostContext): Promise<TaskSessionHostResources> {
		const host = HostProvider.get()
		const browserFactory = () => new BrowserSession(this.options.stateManager)
		const callbackOwner = new ControllerTaskCallbacksOwner({
			controller: this.options.controller,
			taskId: context.taskId,
			stateManager: this.options.stateManager,
			messages: context.messages,
			interactions: context.interactions,
			api: context.api,
			toolState: context.toolState,
			createBrowser: browserFactory,
		})
		const diffViewProvider = host.createDiffViewProvider()
		const fileContextTracker = new FileContextTracker(this.options.controller, context.taskId)
		const taskFileTracker = new TaskFileTracker(context.taskId)
		const contextManager = new ContextManager()
		await contextManager.initializeContextHistory(await ensureTaskDirectoryExists(context.taskId))
		const services = {
			mcpHub: this.options.mcpHub,
			browserSession: callbackOwner.browserSession,
			urlContentFetcher: new UrlContentFetcher(),
			diffViewProvider,
			fileContextTracker,
			taskFileTracker,
			ignoreController: this.options.ignoreController,
			commandPermissionController: new CommandPermissionController(),
			contextManager,
			stateManager: this.options.stateManager,
			imageGenerationService: createImageGenerationRuntime({
				taskId: context.taskId,
				ulid: context.taskIncarnationId,
				stateManager: this.options.stateManager,
				getCurrentMode: () => context.settings.mode,
			}).service,
		}
		const commandCallbacks: CommandExecutorCallbacks = {
			say: (type, text, images, files, partial, existingTs) =>
				callbackOwner.callbacks.say(type as never, text, images, files, partial, existingTs),
			ask: (type, text, partial, commandOptions) =>
				callbackOwner.callbacks.ask(type as never, text, partial, { existingTs: commandOptions?.commandTs }),
			updateBackgroundCommandState: (running) =>
				this.options.controller.updateBackgroundCommandState(running, context.taskId),
			onHandoffAvailabilityChanged: () => void this.options.controller.postStateToWebview(),
			updateClineMessage: (index, updates) => context.messages.updateClineMessage(index, updates),
			getClineMessages: () => context.messages.clineMessages,
			addToUserMessageContent: (content) => context.toolState.userMessageContent.push(content as never),
			createCommandActivity: (input) => {
				context.activities.create({
					activityId: input.activityId,
					kind: "command",
					executionMode: input.executionMode,
					cancellationOwner: input.cancellationOwner,
					title: input.command,
					timeoutSeconds: input.timeoutSeconds,
					cancel: input.cancel,
				})
			},
			updateCommandActivity: (activityId, patch) => context.activities.update(activityId, patch),
			appendCommandActivityOutput: (activityId, text) => context.activities.appendOutput(activityId, text),
		}
		const terminalConfiguration = {
			shellIntegrationTimeout: this.options.stateManager.getGlobalSettingsKey("shellIntegrationTimeout"),
			terminalReuseEnabled: this.options.stateManager.getGlobalStateKey("terminalReuseEnabled") ?? true,
			terminalOutputLineLimit: this.options.stateManager.getGlobalSettingsKey("terminalOutputLineLimit") ?? 500,
			defaultTerminalProfile: this.options.stateManager.getGlobalSettingsKey("defaultTerminalProfile") ?? "default",
		}
		const terminalManager = host.createTerminalManager()
		const commands = new CommandExecutor(
			{
				cwd: context.cwd,
				taskId: context.taskId,
				ulid: context.taskIncarnationId,
				terminalExecutionMode: this.options.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode"),
				terminalCommandHandoffSeconds: this.options.stateManager.getGlobalSettingsKey("terminalCommandHandoffSeconds"),
				terminalManager,
				workspaceRoots: this.options.workspaceManager?.getRoots().map((root) => root.path) ?? [context.cwd],
				terminalConfiguration,
				windowsProcessTreeProvider: host.windowsProcessTreeProvider,
			},
			commandCallbacks,
		)
		callbackOwner.bindCommandExecutor(commands)
		const checkpointOwner = new ControllerTaskCheckpointOwner({
			controller: this.options.controller,
			taskId: context.taskId,
			stateManager: this.options.stateManager,
			messages: context.messages,
			toolState: context.toolState,
			contextManager,
			fileContextTracker,
			taskFileTracker,
			diffViewProvider,
			say: callbackOwner.callbacks.say,
			workspaceManager: this.options.workspaceManager,
		})
		callbackOwner.bindCheckpointManager(checkpointOwner.manager)
		await callbackOwner.initialize()
		const surface: ToolDomainSurface = {
			kind: "user_facing",
			ask: (type, payload, partial) => callbackOwner.callbacks.ask(type as never, payload, partial),
			say: async (type, payload, partial) => {
				await callbackOwner.callbacks.say(type as never, payload, undefined, undefined, partial)
			},
			openInteraction: (request) => context.interactions.open(request as never),
			diff: () => diffViewProvider,
		}
		return {
			services,
			callbacks: callbackOwner.callbacks,
			browser: callbackOwner.browserSession,
			commands,
			terminals: terminalManager,
			checkpoints: checkpointOwner.manager,
			surface,
			compaction: new ControllerTaskCompactionService(context.api, context.taskId),
			spawn: new ControllerTaskSpawnLauncher({
				context: this.options.context,
				parent: this.options.controller,
				parentTaskId: context.taskId,
			}),
			controllerContext: this.options.context,
			releases: [{ release: () => callbackOwner.dispose() }, { release: async () => fileContextTracker.dispose() }],
		}
	}
}
