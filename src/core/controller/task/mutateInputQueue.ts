import type { InputQueueMutation } from "@core/task/input-queue/InputQueueMutation"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { InputQueueDraft as WireInputQueueDraft } from "@shared/proto/dline/task"
import { MutateInputQueueRequest, MutateInputQueueResponse } from "@shared/proto/dline/task"
import { fromProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { Logger } from "@shared/services/Logger"
import { Controller } from ".."

/** One draft carried by an enqueue or edit commit, with its structure decoded. */
interface DecodedDraft {
	readonly text: string
	readonly images: readonly string[]
	readonly files: readonly string[]
	readonly activeQuote?: string
	readonly semanticInput?: SemanticInputDocument
}

/**
 * Decode the submitted structure at the transport boundary.
 *
 * An undecodable document is dropped and diagnosed rather than stored: the queue
 * would otherwise retain a structure no later stage can validate, and the user's
 * text is still deliverable on its own.
 */
function toDraft(wire: WireInputQueueDraft | undefined): DecodedDraft | undefined {
	if (!wire) return undefined
	const { semanticInput: wireDocument, ...draft } = wire
	if (!wireDocument) return draft

	const decoded = fromProtoSemanticInputDocument(wireDocument)
	if (!decoded.ok) {
		Logger.warn(`[inputQueue] Dropping undecodable semantic input: ${decoded.diagnostic.code}`)
		return draft
	}
	return { ...draft, semanticInput: decoded.document }
}

/**
 * Translate the proto oneof into the queue's own mutation shape.
 *
 * Only one field is ever set by the transport; anything else is reported as a
 * missing operation by the queue itself rather than being guessed at here.
 */
function toMutation(request: MutateInputQueueRequest): InputQueueMutation {
	return {
		enqueue: request.enqueue && { draft: toDraft(request.enqueue.draft) },
		toggleMode: request.toggleMode,
		reorder: request.reorder,
		beginEdit: request.beginEdit,
		commitEdit: request.commitEdit && {
			entryId: request.commitEdit.entryId,
			draft: toDraft(request.commitEdit.draft),
		},
		cancelEdit: request.cancelEdit,
		remove: request.remove,
	}
}

/**
 * Applies one user-driven change to the current task's input queue.
 *
 * The task id is checked so a change composed against an older task cannot land
 * on whatever task happens to be active now; the queue is per-task state and
 * silently retargeting it would deliver the user's text to the wrong place.
 */
export async function mutateInputQueue(
	controller: Controller,
	request: MutateInputQueueRequest,
): Promise<MutateInputQueueResponse> {
	const task = controller.task
	if (!task || (request.taskId && task.taskId !== request.taskId) || !task.owners.inputQueue) {
		return MutateInputQueueResponse.create({ accepted: false, result: "missing_task" })
	}
	const outcome = await task.owners.inputQueue.mutate(toMutation(request))
	return MutateInputQueueResponse.create(outcome)
}
