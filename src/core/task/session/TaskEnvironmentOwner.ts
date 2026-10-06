import type { IgnoreController } from "@core/ignore/IgnoreController"
import type { StateManager } from "@core/storage/StateManager"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import type { ITerminalManager } from "@integrations/terminal/types"
import type { BackgroundSubagentProvider } from "../background/BackgroundContextInjector"
import type { TaskEnvironmentHost } from "../composition/TaskSessionPorts"
import { TaskEnvironmentProjection } from "../environment/TaskEnvironmentProjection"
import type { ComposeEnvironmentPort } from "../executors/compose/ProductionComposeAdapter"
import type { TaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { TaskStateManager } from "../TaskStateManager"
import type { DefaultToolHandlerState } from "../tools/state/ToolHandlerState"
import type { TaskServices } from "../tools/types/TaskConfig"
import type { TaskApiHandlerOwner } from "./TaskApiHandlerOwner"

export interface TaskEnvironmentOwnerOptions {
	readonly taskId: string
	readonly cwd: string
	readonly host: TaskEnvironmentHost
	readonly stateManager: StateManager
	readonly settings: TaskStateManager
	readonly api: TaskApiHandlerOwner
	readonly messages: MessageStateHandler
	readonly toolState: DefaultToolHandlerState
	readonly services: Pick<TaskServices, "fileContextTracker" | "taskFileTracker">
	readonly ignoreController: IgnoreController
	readonly workspaceManager?: WorkspaceRootManager
	readonly terminals: ITerminalManager
	readonly commands: CommandExecutor
	readonly subagents: BackgroundSubagentProvider
	readonly readState: () => Readonly<TaskState>
}

/**
 * Task-scoped owner of the environment block appended to every composed round.
 *
 * Wraps the host-facing projection behind the compose port so the compose
 * domain never learns about terminals, trackers or workspace roots. The first
 * round of a session carries the full file listing, later rounds only the
 * dynamic sections, matching the legacy request loop.
 */
export class TaskEnvironmentOwner implements ComposeEnvironmentPort {
	private readonly projection: TaskEnvironmentProjection
	private renderedFileDetails = false

	constructor(options: TaskEnvironmentOwnerOptions) {
		this.projection = new TaskEnvironmentProjection({
			identity: { taskId: options.taskId, cwd: options.cwd },
			host: options.host,
			workspace: {
				stateManager: options.stateManager,
				manager: options.workspaceManager,
				ignoreController: options.ignoreController,
			},
			runtime: {
				getApi: () => options.api.current(),
				getMode: () => options.settings.mode,
				getPhase: () => options.readState().flow.phase,
			},
			conversation: { messages: options.messages, taskState: options.toolState },
			execution: { terminals: options.terminals, tools: options.subagents, commands: options.commands },
			tracking: { files: options.services.fileContextTracker, taskFiles: options.services.taskFileTracker },
		})
	}

	async render(input: { readonly signal: AbortSignal }): Promise<string | undefined> {
		if (input.signal.aborted) throw input.signal.reason
		const text = await this.projection.build(!this.renderedFileDetails)
		if (input.signal.aborted) throw input.signal.reason
		this.renderedFileDetails = true
		// The snapshot is journaled with the round, so what it described is now
		// on its way to the model and must not be reported as new again.
		this.projection.acknowledgeRequestSnapshots()
		return text
	}

	/**
	 * The block the next round would carry, without consuming anything it reports.
	 *
	 * A compaction measures the request it is condensing toward; that request
	 * has not been sent, so the snapshots it describes must still be new to it.
	 */
	async preview(input: { readonly signal: AbortSignal }): Promise<string | undefined> {
		if (input.signal.aborted) throw input.signal.reason
		const text = await this.projection.build(!this.renderedFileDetails, undefined, { preview: true })
		if (input.signal.aborted) throw input.signal.reason
		return text
	}
}
