import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { InputQueue, InputQueueDraft } from "./InputQueue"

/** Draft as it arrives from the transport, where optional fields may be absent. */
interface WireDraft {
	text: string
	images?: readonly string[]
	files?: readonly string[]
	activeQuote?: string
	semanticInput?: SemanticInputDocument
}

/**
 * One user-driven queue change.
 *
 * The shape mirrors the proto `oneof`, but is declared structurally so the
 * queue logic stays testable without constructing protobuf messages.
 */
export interface InputQueueMutation {
	enqueue?: { draft?: WireDraft }
	toggleMode?: { entryId: string }
	reorder?: { entryId: string; targetIndex: number }
	beginEdit?: { entryId: string }
	commitEdit?: { entryId: string; draft?: WireDraft }
	cancelEdit?: { entryId: string }
	remove?: { entryId: string }
}

export interface InputQueueMutationResult {
	readonly accepted: boolean
	/**
	 * Machine-readable outcome: the new entry id, the resulting mode, `"ok"`, or
	 * a failure reason. Callers surface it for diagnostics rather than display.
	 */
	readonly result: string
}

const ok = (result: string): InputQueueMutationResult => ({ accepted: true, result })
const failed = (result: string): InputQueueMutationResult => ({ accepted: false, result })

function toDraft(wire: WireDraft | undefined): InputQueueDraft {
	return {
		text: wire?.text ?? "",
		images: wire?.images ?? [],
		files: wire?.files ?? [],
		activeQuote: wire?.activeQuote || undefined,
		// Already decoded and validated at the transport boundary; the queue
		// stores the structure rather than deriving it from `text` again.
		semanticInput: wire?.semanticInput,
	}
}

/**
 * Apply one mutation to the queue and report a machine-readable outcome.
 *
 * A missing entry is reported rather than ignored: the Webview renders a
 * projection of this queue, so a silent no-op would leave the two views
 * disagreeing with no signal that anything went wrong.
 */
export function applyInputQueueMutation(queue: InputQueue, mutation: InputQueueMutation): InputQueueMutationResult {
	if (mutation.enqueue) {
		const id = queue.enqueue(toDraft(mutation.enqueue.draft))
		return id ? ok(id) : failed("queue_full")
	}
	if (mutation.toggleMode) {
		const mode = queue.toggleMode(mutation.toggleMode.entryId)
		return mode ? ok(mode) : failed("missing_entry")
	}
	if (mutation.reorder) {
		const moved = queue.reorder(mutation.reorder.entryId, mutation.reorder.targetIndex)
		return moved ? ok("ok") : failed("missing_entry")
	}
	if (mutation.beginEdit) {
		const entry = queue.beginEdit(mutation.beginEdit.entryId)
		return entry ? ok("ok") : failed("missing_entry")
	}
	if (mutation.commitEdit) {
		const entry = queue.commitEdit(mutation.commitEdit.entryId, toDraft(mutation.commitEdit.draft))
		return entry ? ok("ok") : failed("missing_entry")
	}
	if (mutation.cancelEdit) {
		return queue.cancelEdit(mutation.cancelEdit.entryId) ? ok("ok") : failed("missing_entry")
	}
	if (mutation.remove) {
		return queue.remove(mutation.remove.entryId) ? ok("ok") : failed("missing_entry")
	}
	return failed("missing_operation")
}
