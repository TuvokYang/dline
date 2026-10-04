import type { BlockId, InteractionId, QueuePayloadIdentity, TaskId, TurnId } from "../kernel"

interface DialogResponseFields {
	readonly taskId: TaskId
	readonly turnId: TurnId
	readonly interactionId: InteractionId
	readonly stateRevision: number
	readonly receiverGeneration: number
	readonly draftRef?: string
	readonly selectionRef?: string
	/** Retained queue delivery consumed atomically with a dialog response. */
	readonly queueDeliveryId?: string
	readonly queueDeliveryEntries?: readonly QueuePayloadIdentity[]
	readonly queueDeliveryMode?: "queued" | "steering"
	/** Internal responses retain their original receiver generation across awaits. */
	readonly generation?: number
}

export type TaskUiAction =
	| (DialogResponseFields & {
			readonly type: "dialog.respond"
			readonly actionId: string
	  })
	| (DialogResponseFields & {
			readonly type: "approval.respond"
			readonly blockId: BlockId
			readonly approved: boolean
	  })
