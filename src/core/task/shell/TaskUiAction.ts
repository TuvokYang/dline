import type { BlockId, InteractionId, TaskId, TurnId } from "../kernel"

interface DialogResponseFields {
	readonly taskId: TaskId
	readonly turnId: TurnId
	readonly interactionId: InteractionId
	readonly stateRevision: number
	readonly receiverGeneration: number
	readonly draftRef?: string
	readonly selectionRef?: string
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
