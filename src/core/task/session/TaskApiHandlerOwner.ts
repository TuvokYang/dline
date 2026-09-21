import { type ApiHandler, buildApiHandler } from "@core/api"
import type { StateManager } from "@core/storage/StateManager"
import type { TaskStateManager } from "../TaskStateManager"

export interface TaskApiHandlerOwnerOptions {
	readonly taskId: string
	readonly taskIncarnationId: string
	readonly stateManager: StateManager
	readonly settings: TaskStateManager
}

/** Owns the replaceable provider handler for one task incarnation. */
export class TaskApiHandlerOwner {
	private handler: ApiHandler

	constructor(private readonly options: TaskApiHandlerOwnerOptions) {
		this.handler = this.build()
	}

	current(): ApiHandler {
		return this.handler
	}

	async rebuild(options: { readonly abortPrevious?: boolean } = {}): Promise<ApiHandler> {
		const previous = this.handler
		const next = this.build()
		this.handler = next
		if (options.abortPrevious) previous.abort?.()
		return next
	}

	abort(): void {
		this.handler.abort?.()
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
