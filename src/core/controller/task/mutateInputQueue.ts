import type { DraftDocumentAdoption } from "@core/input-semantics/DraftInputResourceStore"
import { bindDraftDocument } from "@core/input-semantics/OpeningDocumentBinding"
import type { CanonicalInputQueueMutation } from "@core/task/session/InputQueueApplicationPort"
import { SemanticInputRejectedError } from "@core/task/session/TaskInputAdmission"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { InputQueueDraft as WireInputQueueDraft } from "@shared/proto/dline/task"
import { MutateInputQueueRequest, MutateInputQueueResponse } from "@shared/proto/dline/task"
import { decodeAdmissibleSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
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
 * An undecodable or structurally inadmissible document is refused rather than
 * reinterpreted as text: otherwise inert pasted command nodes could be admitted
 * as live command authority.
 */
function toDraft(wire: WireInputQueueDraft | undefined): DecodedDraft | undefined {
    if (!wire) return undefined
    const { semanticInput: wireDocument, ...draft } = wire
    if (!wireDocument) return draft

    const decoded = decodeAdmissibleSemanticInputDocument(wireDocument)
    if (!decoded.ok) {
        Logger.warn(`[inputQueue] Refusing inadmissible semantic input: ${decoded.diagnostic.code}`)
        throw new Error("InvalidQueueSemanticInput")
    }
    return { ...draft, semanticInput: decoded.document }
}

/**
 * Translate the proto oneof into the queue's own mutation shape.
 *
 * Only one field is ever set by the transport; anything else is reported as a
 * missing operation by the queue itself rather than being guessed at here.
 */
function toMutation(request: MutateInputQueueRequest): CanonicalInputQueueMutation | undefined {
    if (request.enqueue)
        return {
            kind: "enqueue",
            draft: toDraft(request.enqueue.draft) ?? emptyDraft(),
            mode: request.enqueue.steering ? "steering" : "queued",
        }
    if (request.toggleMode) return { kind: "toggle_mode", entryId: request.toggleMode.entryId }
    if (request.reorder) return { kind: "reorder", entryId: request.reorder.entryId, targetIndex: request.reorder.targetIndex }
    if (request.beginEdit) return { kind: "begin_edit", entryId: request.beginEdit.entryId }
    if (request.commitEdit)
        return {
            kind: "commit_edit",
            entryId: request.commitEdit.entryId,
            draft: toDraft(request.commitEdit.draft) ?? emptyDraft(),
        }
    if (request.cancelEdit) return { kind: "cancel_edit", entryId: request.cancelEdit.entryId }
    if (request.remove) return { kind: "remove", entryId: request.remove.entryId }
    return undefined
}

function emptyDraft(): DecodedDraft {
    return { text: "", images: [], files: [] }
}

/**
 * Bind the draft an enqueue or an edit carries to the task's own resources.
 *
 * A composer that staged while the task was only displayed holds its
 * attachments under its draft, and the task's admission reads its own store.
 */
async function bindMutationDraft(
    mutation: CanonicalInputQueueMutation,
    taskId: string,
): Promise<{ readonly mutation: CanonicalInputQueueMutation; readonly adoption?: DraftDocumentAdoption }> {
    if ((mutation.kind !== "enqueue" && mutation.kind !== "commit_edit") || !mutation.draft.semanticInput) return { mutation }
    const adoption = await bindDraftDocument(mutation.draft.semanticInput, taskId)
    return { mutation: { ...mutation, draft: { ...mutation.draft, semanticInput: adoption.document } }, adoption }
}

/**
 * Applies one user-driven change to the current task's input queue.
 *
 * The task id is checked so a change composed against an older task cannot land
 * on whatever task happens to be active now; the queue is per-task state and
 * silently retargeting it would deliver the user's text to the wrong place.
 *
 * A task reopened from history is first shown as a lightweight display that
 * still lists its persisted queue. A queue control acting on it promotes that
 * display into the writable runtime first, as the compaction and activity
 * controls do; otherwise every change would be refused as a missing task.
 */
/**
 * Operations that arrive once per user action, so the row they changed must be
 * published at once. A reorder is excluded: dragging emits a burst of them and
 * each immediate publication costs a full state build.
 */
const IMMEDIATE_OPERATIONS = new Set<CanonicalInputQueueMutation["kind"]>([
    "enqueue",
    "remove",
    "toggle_mode",
    "begin_edit",
    "commit_edit",
    "cancel_edit",
])

export async function mutateInputQueue(
    controller: Controller,
    request: MutateInputQueueRequest,
): Promise<MutateInputQueueResponse> {
    if (request.taskId && controller.task?.taskId !== request.taskId) {
        await controller.promoteHistoryDisplayForActivityControl(request.taskId)
    }
    const task = controller.task
    if (!task || (request.taskId && task.taskId !== request.taskId)) {
        return MutateInputQueueResponse.create({ accepted: false, result: "missing_task" })
    }
    if (!task.writable) return MutateInputQueueResponse.create({ accepted: false, result: "task_read_only" })
    let mutation: CanonicalInputQueueMutation | undefined
    try {
        mutation = toMutation(request)
    } catch {
        return MutateInputQueueResponse.create({ accepted: false, result: "invalid_payload" })
    }
    if (!mutation) return MutateInputQueueResponse.create({ accepted: false, result: "missing_operation" })
    let bound: Awaited<ReturnType<typeof bindMutationDraft>>
    try {
        bound = await bindMutationDraft(mutation, task.taskId)
    } catch (error) {
        if (!(error instanceof SemanticInputRejectedError)) throw error
        Logger.warn(`[inputQueue] Refusing a draft whose attachments could not be adopted: ${error.message}`)
        return MutateInputQueueResponse.create({ accepted: false, result: "invalid_payload" })
    }
    mutation = bound.mutation
    const outcome = await task.inputQueue.mutate(mutation)
    if (!outcome.accepted) {
        // A refused change left the queue untouched, so there is nothing to show.
        return MutateInputQueueResponse.create(outcome)
    }
    // The queue holds the draft's attachments now, so the draft copies go.
    await bound.adoption?.release()
    // The Webview keeps no local queue copy, so an accepted mutation that is not
    // published stays invisible until some unrelated state change happens to
    // publish next. An idle task has no such change.
    await controller.postStateToWebview(IMMEDIATE_OPERATIONS.has(mutation.kind) ? { immediate: true } : undefined)
    return MutateInputQueueResponse.create(outcome)
}
