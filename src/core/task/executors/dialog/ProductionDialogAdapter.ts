import type { TaskState } from "../../kernel"
import type { ConversationJournal, TaskViewPort } from "../../stores"
import type { DialogExecutionPort, DialogPreparationResult, DialogRevealResult } from "./DialogCommandExecutor"

export interface ProductionDialogAdapterOptions {
	readonly taskId: string
	readonly journal: ConversationJournal
	readonly taskView: TaskViewPort
	readonly readState: () => Readonly<TaskState>
}

/** Persists dialog preparation before publishing a transient reveal projection. */
export class ProductionDialogAdapter implements DialogExecutionPort {
	private readonly revealed = new Set<string>()

	constructor(private readonly options: ProductionDialogAdapterOptions) {}

	async prepare(input: Parameters<DialogExecutionPort["prepare"]>[0]): Promise<DialogPreparationResult> {
		if (input.signal.aborted) throw input.signal.reason
		const appended = await this.options.journal.append({
			operationId: input.prepareKey,
			payloadRef: input.presentationRef,
			source: "dialog",
			causation: {
				commandId: input.commandId,
				originRevision: input.originRevision,
				generation: input.generation,
				turnId: input.turnId,
				interactionId: input.interactionId,
			},
		})
		if (input.signal.aborted) throw input.signal.reason
		return {
			journalRef: `journal:${appended.watermark.epoch}:${appended.watermark.seq}`,
			journalWatermark: appended.watermark,
			receiverGeneration: this.options.readState().generation,
			disposition: appended.disposition === "appended" ? "created" : "existing",
		}
	}

	async reveal(input: Parameters<DialogExecutionPort["reveal"]>[0]): Promise<DialogRevealResult> {
		if (input.signal.aborted) throw input.signal.reason
		if (this.revealed.has(input.revealKey)) return { disposition: "already_revealed" }
		this.options.taskView.notifyTransient(this.options.taskId, {
			kind: "dialog_reveal",
			interactionId: input.interactionId,
			turnId: input.turnId,
			blockId: input.blockId,
			presentationKind: input.kind,
			presentationRef: input.presentationRef,
			actionRules: input.actionRules,
			journalRef: input.journalRef,
			receiverGeneration: input.receiverGeneration,
			revealKey: input.revealKey,
		})
		this.revealed.add(input.revealKey)
		return { disposition: "revealed" }
	}

	async dismiss(input: Parameters<NonNullable<DialogExecutionPort["dismiss"]>>[0]): Promise<void> {
		this.options.taskView.notifyTransient(this.options.taskId, {
			kind: "dialog_dismiss",
			interactionId: input.interactionId,
			revealKey: input.revealKey,
			reason: input.reason,
		})
	}
}
