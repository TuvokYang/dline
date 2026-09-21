import type { EventSubmissionResult, TaskRuntime } from "../runtime"
import type { TaskPayloadStore } from "../stores"
import type { TaskInput, TaskShell } from "./TaskShell"
import type { TaskUiAction } from "./TaskUiAction"

export interface TaskSessionComponents {
	readonly shell: TaskShell
	readonly runtime: TaskRuntime
	readonly payloads: TaskPayloadStore
}

/** Thin production facade exposing only the six task-shell use cases. */
export class Task {
	constructor(
		readonly taskId: string,
		private readonly components: TaskSessionComponents,
	) {}

	start(input: TaskInput): Promise<EventSubmissionResult> {
		return this.components.shell.start(input)
	}

	submitInput(input: TaskInput): Promise<EventSubmissionResult> {
		return this.components.shell.submitInput(input)
	}

	respond(action: TaskUiAction): Promise<EventSubmissionResult> {
		return this.components.shell.respond(action)
	}

	cancel(haltId: string): Promise<EventSubmissionResult> {
		return this.components.shell.cancel(haltId)
	}

	terminate(haltId: string): Promise<EventSubmissionResult> {
		return this.components.shell.terminate(haltId)
	}

	open(): Promise<EventSubmissionResult> {
		return this.components.shell.open()
	}
}
