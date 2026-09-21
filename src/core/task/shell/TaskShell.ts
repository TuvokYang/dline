import type { EventSubmissionResult, RuntimeFacade } from "../runtime"
import type { TaskUiAction } from "./TaskUiAction"

export interface TaskInput {
	readonly entryId: string
	readonly payloadRef: string
	readonly mode?: "queued" | "steering"
	readonly sequence?: number
}

export interface TaskHaltRearmPort {
	rearm(haltId: string): Promise<void>
}

/** Shows an accepted submission as the user's own chat row. */
export interface TaskInputPresentationPort {
	present(input: TaskInput): Promise<void>
}

export class TaskShell {
	constructor(
		private readonly runtime: RuntimeFacade,
		private readonly halt: TaskHaltRearmPort,
		private readonly presentation?: TaskInputPresentationPort,
	) {}

	async start(input: TaskInput): Promise<EventSubmissionResult> {
		const opened = await this.open()
		if (opened.kind === "rejected") return opened
		return this.submitInput(input)
	}

	async submitInput(input: TaskInput): Promise<EventSubmissionResult> {
		const submitted = await this.runtime.submit({
			type: "user.submit",
			generation: this.runtime.getState().generation,
			entryId: input.entryId,
			payloadRef: input.payloadRef,
			mode: input.mode,
			sequence: input.sequence,
		})
		// The chat row follows acceptance, so a refused submission never leaves a
		// message for an entry the task does not own.
		if (submitted.kind !== "rejected") await this.presentation?.present(input)
		return submitted
	}

	async respond(action: TaskUiAction): Promise<EventSubmissionResult> {
		const dialog = await this.runtime.submit({
			type: "dialog.responded",
			generation: this.runtime.getState().generation,
			taskId: action.taskId,
			turnId: action.turnId,
			interactionId: action.interactionId,
			stateRevision: action.stateRevision,
			receiverGeneration: action.receiverGeneration,
			actionId: action.type === "approval.respond" ? (action.approved ? "approve" : "reject") : action.actionId,
			draftRef: action.draftRef,
			selectionRef: action.selectionRef,
		})
		if (dialog.kind === "rejected" || action.type === "dialog.respond") return dialog
		await this.runtime.waitForDurable(dialog.state.revision)
		return this.runtime.submit({
			type: "approval.responded",
			generation: this.runtime.getState().generation,
			turnId: action.turnId,
			blockId: action.blockId,
			interactionId: action.interactionId,
			approved: action.approved,
		})
	}

	cancel(haltId: string): Promise<EventSubmissionResult> {
		return this.haltTask("user.cancel", haltId)
	}

	terminate(haltId: string): Promise<EventSubmissionResult> {
		return this.haltTask("user.terminate", haltId)
	}

	open(): Promise<EventSubmissionResult> {
		return this.runtime.submit({ type: "lifecycle.open", generation: this.runtime.getState().generation })
	}

	private async haltTask(type: "user.cancel" | "user.terminate", haltId: string): Promise<EventSubmissionResult> {
		const result = await this.runtime.submit({ type, generation: this.runtime.getState().generation, haltId })
		if (result.kind === "rejected") return result
		await this.runtime.waitForDomainCompletion(result.state.revision)
		await this.runtime.waitForQuiescence()
		await this.halt.rearm(haltId)
		return result
	}
}
