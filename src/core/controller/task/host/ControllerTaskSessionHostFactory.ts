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
import { SessionResourceScope } from "@core/task/session/SessionResourceScope"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { TaskFileTracker } from "@integrations/checkpoints/TaskFileTracker"
import { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import type { CommandExecutorCallbacks } from "@integrations/terminal/types"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import type { McpHub } from "@services/mcp/McpHub"
import type { ClineExtensionContext } from "@shared/cline/context"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Logger } from "@shared/services/Logger"
import { HostProvider } from "@/hosts/host-provider"
import { sendPartialMessageEvent } from "../../ui/subscribeToPartialMessage"
import { ControllerTaskCallbacksOwner } from "./ControllerTaskCallbacksOwner"
import { ControllerTaskCheckpointOwner } from "./ControllerTaskCheckpointOwner"
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
        const rollback = new SessionResourceScope()
        try {
            return await this.createResources(context, rollback)
        } catch (error) {
            try {
                await rollback.release()
            } catch (cleanupError) {
                Logger.error(`[Task ${context.taskId}] Failed to release partially created host resources`, cleanupError)
            }
            throw error
        }
    }

    private async createResources(
        context: TaskSessionHostContext,
        rollback: SessionResourceScope,
    ): Promise<TaskSessionHostResources> {
        const host = HostProvider.get()
        const browserFactory = () => new BrowserSession(this.options.stateManager)
        // The incarnation is this opening's identity: rows it publishes are attributed to it.
        const opening = { taskId: context.taskId, taskInstanceId: context.taskIncarnationId }
        const callbackOwner = new ControllerTaskCallbacksOwner({
            controller: this.options.controller,
            taskId: context.taskId,
            taskInstanceId: context.taskIncarnationId,
            stateManager: this.options.stateManager,
            messages: context.messages,
            interactions: context.interactions,
            nextPresentationId: context.nextPresentationId,
            api: context.api,
            toolState: context.toolState,
            createBrowser: browserFactory,
        })
        rollback.add({ release: () => callbackOwner.dispose() })
        const diffViewProvider = host.createDiffViewProvider()
        const fileContextTracker = new FileContextTracker(this.options.controller, context.taskId)
        rollback.add({ release: async () => fileContextTracker.dispose() })
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
            say: (type, text, images, files, partial, existingTs, commandTs) =>
                callbackOwner.callbacks.say(type as never, text, images, files, partial, existingTs, commandTs),
            ask: (type, text, partial, commandOptions) =>
                callbackOwner.callbacks.ask(type as never, text, partial, { existingTs: commandOptions?.commandTs }),
            updateBackgroundCommandState: (running) =>
                this.options.controller.updateBackgroundCommandState(running, context.taskId),
            onHandoffAvailabilityChanged: () => void this.options.controller.postStateToWebview(),
            updateClineMessage: async (index, updates) => {
                await context.messages.updateClineMessage(index, updates)
                // Persisting is not publishing. The command row is already on screen,
                // so a patch that only reaches storage leaves the visible row stale
                // until something unrelated republishes it: an accepted background
                // handoff kept rendering as "Foreground" for the rest of the task.
                // The push is view delivery, so the executor that patched the row
                // does not wait on it: a slow or closed Webview must not stall a
                // command whose change is already durable.
                const row = context.messages.clineMessages[index]
                if (!row) return
                void sendPartialMessageEvent(this.options.controller, convertClineMessageToProto(row), opening).catch(
                    (error: unknown) => {
                        Logger.warn(
                            `[Task ${context.taskId}] Could not publish the patched row ${index}: ${error instanceof Error ? error.message : String(error)}`,
                        )
                    },
                )
            },
            getClineMessages: () => context.messages.clineMessages,
            addToUserMessageContent: (content) => context.toolState.userMessageContent.push(content as never),
            createCommandActivity: (input) => {
                context.activities.create({
                    activityId: input.activityId,
                    kind: "command",
                    executionMode: input.executionMode,
                    cancellationOwner: input.cancellationOwner,
                    // The title is the one-line label; the full command is the detail
                    // the Activities view and a reopened task show.
                    title: input.command.split(/\r?\n/, 1)[0].slice(0, 240) || "Command",
                    detail: input.command,
                    timeoutSeconds: input.timeoutSeconds,
                    cancel: input.cancel,
                })
            },
            updateCommandActivity: (activityId, patch) => {
                const { lineCount, ...activityPatch } = patch
                context.activities.update(activityId, {
                    ...activityPatch,
                    metrics: lineCount === undefined ? undefined : { lineCount },
                })
            },
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
        rollback.add({ release: () => commands.dispose() })
        callbackOwner.bindCommandExecutor(commands)
        const checkpointOwner = new ControllerTaskCheckpointOwner({
            controller: this.options.controller,
            taskId: context.taskId,
            taskInstanceId: context.taskIncarnationId,
            stateManager: this.options.stateManager,
            messages: context.messages,
            toolState: context.toolState,
            contextManager,
            fileContextTracker,
            taskFileTracker,
            diffViewProvider,
            say: callbackOwner.callbacks.say,
            beginRow: (fields) => callbackOwner.beginCheckpointRow(fields),
            holdRow: (fields) => callbackOwner.holdCheckpointRow(fields),
            workspaceManager: this.options.workspaceManager,
            conversationRewind: context.conversationRewind,
            checkpoints: context.checkpoints,
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
        const peerTaskSpawner = new ControllerTaskSpawnLauncher({
            context: this.options.context,
            parentTaskId: context.taskId,
        })
        return {
            services,
            callbacks: callbackOwner.callbacks,
            focusChain: callbackOwner.focusChainInstructions,
            browser: callbackOwner.browserSession,
            commands,
            terminals: terminalManager,
            checkpoints: checkpointOwner.manager,
            surface,
            peerTaskSpawner,
            releases: [
                { release: () => callbackOwner.dispose() },
                { release: async () => fileContextTracker.dispose() },
                // Released with the tool owners, before storage closes: disposal waits for
                // the checkpoint in progress, so it cannot write into a closed message store.
                { release: async () => checkpointOwner.manager.dispose?.() },
            ],
        }
    }
}
