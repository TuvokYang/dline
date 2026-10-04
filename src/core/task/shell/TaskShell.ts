import { planRecoveryDialog } from "../kernel/recovery"
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

/** Reconciles retained queue journal facts only after every owning writer drained. */
export interface TaskRetainedQueueSettlementPort {
	settle(): Promise<void>
}

/** Stops every executor for checkpoint restore and deliberately keeps their fences installed. */
export interface TaskCheckpointRestoreSuspensionPort {
	stopAndFence(haltId: string): Promise<EventSubmissionResult>
}

/**
 * Shows an accepted submission as the user's own chat row.
 *
 * Presentation is split in two because the row's position is part of its
 * meaning. Everything the row needs is resolved before the runtime is told to
 * submit, so the row is ordered ahead of the work the submission causes; the
 * commit is withheld until the submission is accepted, so a refused entry still
 * leaves no message behind. Resolving after submission instead let the turn
 * allocate its blocks first, which placed the user's own message after the
 * replies to it.
 */
export interface TaskInputPresentationPort {
	prepare(input: TaskInput): Promise<TaskInputPresentationCommit>
}

/** A prepared chat row, not yet visible. */
export interface TaskInputPresentationCommit {
	commit(): Promise<void>
}

export class TaskShell {
	constructor(
		private readonly runtime: RuntimeFacade,
		private readonly halt: TaskHaltRearmPort,
		private readonly presentation?: TaskInputPresentationPort,
		private readonly retainedQueueSettlement?: TaskRetainedQueueSettlementPort,
	) {}

	async start(input: TaskInput): Promise<EventSubmissionResult> {
		const opened = await this.open()
		if (opened.kind === "rejected") return opened
		return this.submitInput(input)
	}

	async submitInput(input: TaskInput): Promise<EventSubmissionResult> {
		// Prepared before submission so the row precedes the work it causes, and
		// committed only after acceptance so a refused entry leaves no message.
		const presentation = await this.presentation?.prepare(input)
		const submitted = await this.runtime.submit({
			type: "user.submit",
			generation: this.runtime.getState().generation,
			entryId: input.entryId,
			payloadRef: input.payloadRef,
			mode: input.mode,
			sequence: input.sequence,
		})
		if (submitted.kind !== "rejected") await presentation?.commit()
		return submitted
	}

	async respond(action: TaskUiAction): Promise<EventSubmissionResult> {
		const dialog = await this.runtime.submit({
			type: "dialog.responded",
			generation: action.generation ?? this.runtime.getState().generation,
			taskId: action.taskId,
			turnId: action.turnId,
			interactionId: action.interactionId,
			stateRevision: action.stateRevision,
			receiverGeneration: action.receiverGeneration,
			actionId: action.type === "approval.respond" ? (action.approved ? "approve" : "reject") : action.actionId,
			draftRef: action.draftRef,
			selectionRef: action.selectionRef,
			queueDeliveryId: action.queueDeliveryId,
			queueDeliveryEntries: action.queueDeliveryEntries,
			queueDeliveryMode: action.queueDeliveryMode,
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
			feedbackRef: action.draftRef,
		})
	}

	cancel(haltId: string): Promise<EventSubmissionResult> {
		return this.haltTask("user.cancel", haltId)
	}

	terminate(haltId: string): Promise<EventSubmissionResult> {
		return this.haltTask("user.terminate", haltId)
	}

	/** Stop and drain the live runtime without rearming executors or planning a resume dialog. */
	async stopAndFence(haltId: string): Promise<EventSubmissionResult> {
		const result = await this.haltUntilQuiescent("user.cancel", haltId)
		if (result.kind !== "rejected" && this.runtime.getState().halt.status === "stopping")
			throw new Error(`CheckpointRestoreHaltTimedOut:${haltId}`)
		return result
	}

	/**
	 * Take ownership of the task: dispatch recovered work that was held while the window did
	 * not own the task lock, then submit `lifecycle.open`. Release happens first because an
	 * interrupted task is paused and rejects `lifecycle.open`, yet its recovered work still runs.
	 */
	async open(): Promise<EventSubmissionResult> {
		await this.retainedQueueSettlement?.settle()
		this.runtime.releaseRestoredCommands()
		return this.runtime.submit({ type: "lifecycle.open", generation: this.runtime.getState().generation })
	}

	private async haltTask(type: "user.cancel" | "user.terminate", haltId: string): Promise<EventSubmissionResult> {
		const result = await this.haltUntilQuiescent(type, haltId)
		if (result.kind === "rejected") return result
		if (this.runtime.getState().halt.status === "stopping") {
			void this.finishTimedOutHalt(type, haltId).catch(() => undefined)
			return result
		}
		await this.halt.rearm(haltId)
		if (type === "user.cancel") await this.offerResume()
		return result
	}

	private async haltUntilQuiescent(type: "user.cancel" | "user.terminate", haltId: string): Promise<EventSubmissionResult> {
		const result = await this.runtime.submit({ type, generation: this.runtime.getState().generation, haltId })
		if (result.kind === "rejected") return result
		await this.runtime.waitForDomainCompletion(result.state.revision)
		if (this.runtime.getState().halt.status === "stopping") return result
		await this.runtime.waitForQuiescence()
		await this.retainedQueueSettlement?.settle()
		return result
	}

	private async finishTimedOutHalt(type: "user.cancel" | "user.terminate", haltId: string): Promise<void> {
		await this.halt.rearm(haltId)
		await this.runtime.waitForQuiescence()
		await this.retainedQueueSettlement?.settle()
		if (type === "user.cancel") await this.offerResume()
	}

	/**
	 * Offer the stopped task a way back to work.
	 *
	 * Cancelling only pauses: the conversation is intact and the user is
	 * expected to resume, but nothing else plans that dialog. Hydration covers
	 * the task that was reopened from a snapshot, so a round stopped inside a
	 * live session was the one case left with no interaction at all — the
	 * footer offered neither Cancel nor Resume and the task could not continue.
	 *
	 * Raised here rather than from the halt reducer because the dialog executor
	 * is fenced for the whole halt: a command derived while stopping is dropped
	 * and never retried. After rearm the same command runs normally.
	 */
	private async offerResume(): Promise<void> {
		const state = this.runtime.getState()
		// Terminal tasks have nothing to resume, and an existing primary dialog is
		// already the question the user has to answer.
		if (state.flow.phase !== "paused" || state.dialog.primary) return
		const plan = planRecoveryDialog({
			taskId: state.taskId,
			revision: state.revision,
			reason: "cancelled",
			turnId: state.turn.turnId ?? `cancelled:${state.taskId}`,
		})
		await this.runtime.submit({ type: "dialog.requested", generation: state.generation, ...plan })
	}
}
