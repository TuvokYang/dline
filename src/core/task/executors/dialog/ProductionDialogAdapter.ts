import type { TaskState } from "../../kernel"
import type { ConversationJournal, TaskPayloadStore, TaskViewPort } from "../../stores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { DialogPresentationEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import type { DialogExecutionPort, DialogPreparationResult, DialogRevealResult } from "./DialogCommandExecutor"

/** A payload reference is content-addressed; anything else is the presentation body itself. */
function isPayloadRef(presentationRef: string): boolean {
	return /^sha256:[a-f0-9]{64}$/.test(presentationRef)
}

/** One chat row that pins a revealed dialog to the conversation. */
export interface DialogAnchorRequest {
	readonly interactionId: string
	readonly kind: string
	readonly body: string
}

export interface ProductionDialogAdapterOptions {
	readonly taskId: string
	readonly journal: ConversationJournal
	readonly payloads: TaskPayloadStore
	readonly taskView: TaskViewPort
	readonly readState: () => Readonly<TaskState>
	/**
	 * Write the chat row a revealed dialog is anchored to.
	 *
	 * Only interactions a tool opens for itself arrive with their row already
	 * written. An approval is created from the turn plan instead, so without this
	 * the dialog was awaiting a decision that had no row to attach its controls
	 * to, and the request was never presented.
	 */
	readonly writeAnchor?: (request: DialogAnchorRequest) => Promise<void>
}

/** Persists dialog preparation before publishing a transient reveal projection. */
export class ProductionDialogAdapter implements DialogExecutionPort {
	private readonly revealed = new Set<string>()

	constructor(private readonly options: ProductionDialogAdapterOptions) {}

	async prepare(input: Parameters<DialogExecutionPort["prepare"]>[0]): Promise<DialogPreparationResult> {
		if (input.signal.aborted) throw input.signal.reason
		// An approval is planned from the turn, so its presentation arrives as the
		// body rather than a stored payload. Persisting it here keeps the journal
		// entry readable: a plain body written as a payload reference made the next
		// provider request fail to materialize the conversation at all.
		const payloadRef = await this.resolvePayloadRef(input.presentationRef, input.kind)
		if (input.signal.aborted) throw input.signal.reason
		const appended = await this.options.journal.append({
			operationId: input.prepareKey,
			payloadRef,
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
		// The row has to exist before the projection announces the dialog, so the
		// surface never sees an answerable request it cannot attach controls to.
		await this.options.writeAnchor?.({
			interactionId: input.interactionId,
			kind: input.kind,
			body: input.presentationRef,
		})
		if (input.signal.aborted) throw input.signal.reason
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

	/** Store a presentation body once so the journal always references durable content. */
	private async resolvePayloadRef(presentationRef: string, kind: string): Promise<string> {
		if (isPayloadRef(presentationRef)) return presentationRef
		return this.options.payloads.put(
			encodeTaskPayload<DialogPresentationEnvelope>({
				kind: "dialog_presentation",
				presentationKind: kind,
				body: presentationRef,
			}),
		)
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
