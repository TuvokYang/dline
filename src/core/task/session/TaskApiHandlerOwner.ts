import { type ApiHandler, buildApiHandler } from "@core/api"
import type { StateManager } from "@core/storage/StateManager"
import { Logger } from "@shared/services/Logger"
import type { TaskStateManager } from "../TaskStateManager"

/** Informed once the task's requests are served by a newly built handler. */
export type ApiHandlerRebuiltListener = (handler: ApiHandler) => void

export interface TaskApiHandlerOwnerOptions {
	readonly taskId: string
	readonly taskIncarnationId: string
	readonly stateManager: StateManager
	readonly settings: TaskStateManager
}

/** Owns the replaceable provider handler for one task incarnation. */
export class TaskApiHandlerOwner {
	private handler: ApiHandler
	private readonly rebuiltListeners = new Set<ApiHandlerRebuiltListener>()

	constructor(private readonly options: TaskApiHandlerOwnerOptions) {
		this.handler = this.build()
	}

	current(): ApiHandler {
		return this.handler
	}

	/**
	 * Observes every handler replacement, whichever setting caused it.
	 *
	 * A Mode, Profile, or configuration change all end in a rebuild, so this is
	 * the one place that knows the task now runs under a different scope.
	 */
	onRebuilt(listener: ApiHandlerRebuiltListener): () => void {
		this.rebuiltListeners.add(listener)
		return () => this.rebuiltListeners.delete(listener)
	}

	async rebuild(options: { readonly abortPrevious?: boolean } = {}): Promise<ApiHandler> {
		const previous = this.handler
		const next = this.build()
		this.handler = next
		if (options.abortPrevious) previous.abort?.()
		this.notifyRebuilt(next)
		return next
	}

	abort(): void {
		this.handler.abort?.()
	}

	/** An observer only reflects the new scope; its failure must not undo the switch that caused it. */
	private notifyRebuilt(handler: ApiHandler): void {
		for (const listener of this.rebuiltListeners) {
			try {
				listener(handler)
			} catch (error) {
				Logger.warn(
					`[TaskApiHandlerOwner] ${this.options.taskId}: rebuild observer failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	private build(): ApiHandler {
		return buildApiHandler(
			{
				...this.options.stateManager.getApiConfigurationForTask(this.options.taskId),
				ulid: this.options.taskIncarnationId,
			},
			this.options.settings.mode,
		)
	}
}
