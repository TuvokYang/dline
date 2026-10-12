import type { InteractionOutcome } from "@core/task/interaction/InteractionProtocol"
import type { MessageStateHandler } from "@core/task/message-state"
import { type ReviewedReply, SemanticInputRejectedError } from "@core/task/session/TaskInputAdmission"
import { encodeTaskPayload } from "@core/task/stores/payload/TaskPayloadCodec"
import type { DialogDraftEnvelope, DialogSelectionEnvelope } from "@core/task/stores/payload/TaskPayloadEnvelopes"
import type { AdmittedInputPart } from "@shared/input-semantics/admitted-parts"
import { isResourceNode, type SemanticInputDocument } from "@shared/input-semantics/document"
import {
    rowHasVisibleContent,
    type SubmittedInputRow,
    submittedInputRow,
    submittedRowFields,
} from "@shared/input-semantics/submitted-input"
import { type DispatchInteractionRequest, DispatchInteractionResponse } from "@shared/proto/dline/task"
import { decodeAdmissibleSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { Logger } from "@shared/services/Logger"
import type { Controller } from ".."
import { describeDispatch } from "./describeInteractionDispatch"

/** Stable protocol outcomes for expected interaction response races. */
type DispatchInteractionResult =
    | "accepted"
    | "stale_interaction"
    | "invalid_action"
    | "invalid_payload"
    | "duplicate_response"
    | "missing_task"
    | "invalid_runtime_event"
    | "task_read_only"

function response(accepted: boolean, result: DispatchInteractionResult): DispatchInteractionResponse {
    return DispatchInteractionResponse.create({ accepted, result })
}

/**
 * Decode the structure submitted with a reply.
 *
 * `invalid` means a structure was sent but cannot be read or is structurally
 * inadmissible (duplicate identities, forged resources, several lifecycle
 * barriers). The reply is then
 * refused rather than downgraded to text: the structure is what held pasted
 * command text inert, and text alone would be re-read with every command live.
 */
function decodeDraftDocument(request: DispatchInteractionRequest): {
    readonly document?: SemanticInputDocument
    readonly invalid?: true
} {
    const wire = request.draft?.semanticInput
    if (!wire) return {}
    const decoded = decodeAdmissibleSemanticInputDocument(wire)
    if (decoded.ok) return { document: decoded.document }
    Logger.warn(`dispatchInteraction: refusing a reply with inadmissible semantic input (${decoded.diagnostic.code})`)
    return { invalid: true }
}

/**
 * Whether a reply names its attachments twice: as resource nodes in its
 * document and again as flat lists. The document is the only authority for a
 * structured reply's attachments; flat lists beside resource nodes would be
 * delivered as well, so such a reply is refused instead of guessed at.
 */
function mixesResourceCarriers(draft: DispatchInteractionRequest["draft"], document: SemanticInputDocument): boolean {
    const hasFlatCarriers = (draft?.images.length ?? 0) > 0 || (draft?.files.length ?? 0) > 0
    return hasFlatCarriers && document.nodes.some(isResourceNode)
}

/**
 * Show a reply whose lifecycle command consumed all of it, as the user typed it.
 *
 * The dialog handler echoes only the text a reply keeps; when the command took
 * everything, that is nothing, and the user's own row would never appear.
 * Keyed by the interaction so a replayed dispatch cannot show it twice, and
 * durable before the reply is acknowledged: once the dialog is answered no
 * replay can recreate a row a crash dropped from the buffer.
 *
 * The row is registered before the first await, so it is in the chat before
 * the caller releases the command and the dialog: a summary they produce
 * quickly is published after the user's row, as dev shows the reply first.
 *
 * Built from the reply as submitted, never from its resolved attachments: the
 * receiver reads the resources, the row only names them, so no image data or
 * local path enters the chat history and no file is read twice.
 */
async function showConsumedReply(
    messages: MessageStateHandler,
    nextPresentationId: (() => number) | undefined,
    request: DispatchInteractionRequest,
    shown: SubmittedInputRow,
): Promise<void> {
    const rowId = `reply:${request.interactionId}`
    if (!rowHasVisibleContent(shown) || messages.clineMessages.some((row) => row.interactionId === rowId)) return
    // Rows are ordered by the session's shared sequence; drawing from it keeps
    // the reply ahead of the summary and the turn it causes.
    const lastTs = messages.clineMessages.at(-1)?.ts ?? 0
    const ts = nextPresentationId ? nextPresentationId() : Math.max(Date.now(), lastTs + 1)
    const registered = messages.beginDurableClineMessage({
        ts,
        type: "say",
        say: "user_feedback",
        ...submittedRowFields(shown),
        interactionId: rowId,
    })
    await registered.persistence
}

/**
 * What a reply persists as its attachments.
 *
 * A structured reply's resources are its admitted parts; flat lists remain only
 * for a legacy reply, which never carries both (see {@link mixesResourceCarriers}).
 */
interface ReplyAttachments {
    readonly images: readonly string[]
    readonly files: readonly string[]
    readonly admittedParts: readonly AdmittedInputPart[]
}

function replyAttachmentsOf(draft: DispatchInteractionRequest["draft"], reviewed: ReviewedReply | undefined): ReplyAttachments {
    return {
        images: [...(draft?.images ?? [])],
        files: [...(draft?.files ?? [])],
        admittedParts: reviewed?.parts ?? [],
    }
}

/** The parts field a persisted draft carries; omitted when the reply holds no resource. */
function partsFieldOf(attachments: ReplyAttachments): { readonly admittedParts?: readonly AdmittedInputPart[] } {
    return attachments.admittedParts.length > 0 ? { admittedParts: attachments.admittedParts } : {}
}

/** The dialog action that abandons the task for a fresh one instead of answering it. */
const START_NEW_TASK_ACTION = "start_new_task"

/**
 * Close the task after the user chose Start New Task on one of its dialogs.
 *
 * The action abandons this task, so the answer is not handed to the dialog's
 * receiver: a completion would turn it into a tool result and compose another
 * round in the task the user just left. The close is queued rather than
 * awaited because a history-display dispatch already holds the lifecycle lock,
 * which is not reentrant; queued behind it, the close still runs before any
 * later lifecycle operation, such as the user's next task.
 */
function closeForNewTask(controller: Controller, session: NonNullable<Controller["task"]>): void {
    void controller
        .runTaskLifecycleOperation(async (scope) => {
            // A lifecycle operation queued earlier may already have replaced the task.
            if (controller.task !== session) return
            await scope.clearTask({ clearPanelState: true, preserveCompletedState: true, deferTeardown: true })
        })
        .catch((error: unknown) => {
            Logger.warn(
                `dispatchInteraction: could not close task ${session.taskId} for a new task: ${error instanceof Error ? error.message : String(error)}`,
            )
        })
}

function normalizeResult(reason: string): DispatchInteractionResult {
    if (reason === "identity_mismatch" || reason === "generation_mismatch" || reason === "stale_attempt")
        return "stale_interaction"
    if (reason === "duplicate") return "duplicate_response"
    if (reason === "read_only") return "task_read_only"
    return "invalid_runtime_event"
}

/** Dispatch one causally identified Webview interaction response through the canonical Task shell. */
export async function dispatchInteraction(
    controller: Controller,
    request: DispatchInteractionRequest,
): Promise<DispatchInteractionResponse> {
    const session = controller.task
    // A closed task can still own a durable interaction rendered from history.
    if (!session) return (await controller.dispatchHistoryDisplayInteraction(request)) ?? response(false, "missing_task")
    const state = session.state()
    // A response is bound to the opening that rendered it: the same task reopened
    // is a different opening, and a dialog shown by the previous one is stale.
    if (request.taskId !== session.taskId || !request.taskInstanceId || request.taskInstanceId !== session.taskInstanceId) {
        Logger.warn(
            `[dispatchInteraction] Refused a reply from another opening of task ${session.taskId}: ${describeDispatch(request)}`,
        )
        return response(false, "stale_interaction")
    }
    // Another window owns the task: its draft and selection must not be stored here.
    if (!session.writable) return response(false, "task_read_only")
    // An interrupted task parks its recovery dialog under `interrupted`, so Resume
    // must be answerable there as well as on a live primary.
    const owner = [state.dialog.primary, state.dialog.interrupted].find(
        (candidate) => candidate?.interactionId === request.interactionId,
    )
    const primary = owner
    const approvalEntry = Object.entries(state.dialog.approvalsByBlock).find(
        ([, interaction]) => interaction.interactionId === request.interactionId,
    )
    const interaction = primary ?? approvalEntry?.[1]
    if (
        !interaction ||
        interaction.turnId !== request.turnId ||
        interaction.status !== "awaiting" ||
        request.stateRevision < interaction.createdRevision ||
        request.stateRevision > state.revision
    )
        return response(false, "stale_interaction")
    if (!interaction.actionRules.some((rule) => rule.actionId === request.actionId)) return response(false, "invalid_action")
    if (interaction.receiverGeneration === undefined) return response(false, "invalid_runtime_event")

    const decodedDraft = decodeDraftDocument(request)
    if (decodedDraft.invalid) return response(false, "invalid_payload")
    const draftDocument = decodedDraft.document
    if (draftDocument && mixesResourceCarriers(request.draft, draftDocument)) {
        Logger.warn(`dispatchInteraction: refusing a reply to ${request.interactionId} that carries resources twice`)
        return response(false, "invalid_payload")
    }
    // A reply is user input like any submission: a lifecycle command typed into
    // it acts instead of reaching the model as literal feedback. What remains is
    // the text the reply keeps once the command and its premessage are taken out;
    // the command itself only acts once the runtime accepted the reply below.
    let reviewed: ReviewedReply | undefined
    try {
        reviewed = request.draft
            ? await session.inputs.reviewReply({
                  text: request.draft.text,
                  images: [...request.draft.images],
                  files: [...request.draft.files],
                  ...(draftDocument === undefined ? {} : { semanticInput: draftDocument }),
              })
            : undefined
    } catch (error) {
        // A structured reply is read exactly as composed or not at all; nothing
        // was written or answered yet, so the caller still owns the draft.
        if (!(error instanceof SemanticInputRejectedError)) throw error
        Logger.warn(`dispatchInteraction: reply to ${request.interactionId} was rejected: ${error.message}`)
        return response(false, "invalid_payload")
    }
    const draftText = request.draft ? (reviewed?.text ?? request.draft.text) : undefined
    // A structured reply persists its verified resources as parts; a receiver that
    // reads flat lists resolves them only when it consumes the draft.
    const attachments = replyAttachmentsOf(request.draft, reviewed)
    // Once a command was taken out, only the structure before it is the reply;
    // storing the whole document would let a later admission act on it again.
    const storedDocument = reviewed ? reviewed.document : draftDocument
    const draftRef = request.draft
        ? await session.payloads.put(
              encodeTaskPayload<DialogDraftEnvelope>({
                  kind: "dialog_draft",
                  text: draftText ?? request.draft.text,
                  images: [...attachments.images],
                  files: [...attachments.files],
                  ...(storedDocument === undefined ? {} : { semanticInput: storedDocument }),
                  ...partsFieldOf(attachments),
              }),
          )
        : undefined
    const selectionRef = request.selection
        ? await session.payloads.put(
              encodeTaskPayload<DialogSelectionEnvelope>({ kind: "dialog_selection", values: [...request.selection.values] }),
          )
        : undefined
    const replyConsumed = Boolean(reviewed && !reviewed.text && request.draft?.text)
    // An approval's note reaches the model only through the block's result, never
    // as intake, so no other path shows the user the note they sent with it.
    const approvalNote = Boolean(approvalEntry && hasDraftContent(request.draft, attachments))
    const showsReply = replyConsumed || approvalNote
    // An approval is planned from the turn, so its draft is not an intake entry.
    // Recording it against the block is the only route into the next provider
    // request; without it a note typed while approving is silently discarded.
    // It is recorded before the response so the block's result can never be
    // produced without it, and undone below if the runtime refuses the response.
    const feedbackBlockId = approvalEntry && request.draft ? approvalEntry[0] : undefined
    const priorFeedback = feedbackBlockId ? session.approvalFeedback.take(feedbackBlockId) : undefined
    if (feedbackBlockId && request.draft) {
        session.approvalFeedback.record(feedbackBlockId, {
            text: draftText ?? request.draft.text,
            images: [...attachments.images],
            files: [...attachments.files],
            ...partsFieldOf(attachments),
        })
    }
    const result = approvalEntry
        ? await session.task.respond({
              type: "approval.respond",
              taskId: session.taskId,
              turnId: interaction.turnId,
              interactionId: interaction.interactionId,
              stateRevision: request.stateRevision,
              receiverGeneration: interaction.receiverGeneration,
              blockId: approvalEntry[0],
              approved: request.actionId === "approve",
              draftRef,
              selectionRef,
          })
        : await session.task.respond({
              type: "dialog.respond",
              taskId: session.taskId,
              turnId: interaction.turnId,
              interactionId: interaction.interactionId,
              stateRevision: request.stateRevision,
              receiverGeneration: interaction.receiverGeneration,
              actionId: request.actionId,
              draftRef,
              selectionRef,
          })
    if (result.kind === "rejected") {
        // A refused response (stale or a duplicate of an accepted one) must not
        // replace the note the accepted response left for this block.
        if (feedbackBlockId) {
            session.approvalFeedback.take(feedbackBlockId)
            if (priorFeedback) session.approvalFeedback.record(feedbackBlockId, priorFeedback)
        }
        return response(false, normalizeResult(result.reason))
    }
    try {
        await result.receipt.durable
    } catch (error) {
        if (feedbackBlockId) {
            session.approvalFeedback.take(feedbackBlockId)
            if (priorFeedback) session.approvalFeedback.record(feedbackBlockId, priorFeedback)
        }
        Logger.error(
            `dispatchInteraction: accepted reply was not durable for ${request.interactionId}: ${error instanceof Error ? error.message : String(error)}`,
        )
        return response(false, "invalid_runtime_event")
    }
    const denialPresentation =
        approvalEntry && request.actionId === "reject"
            ? (() => {
                  const block = state.turn.blocks.find((candidate) => candidate.blockId === approvalEntry[0])
                  if (!block) {
                      Logger.warn(`dispatchInteraction: accepted rejection has no block ${approvalEntry[0]}`)
                      return undefined
                  }
                  return session.owners.toolExecution.presentDenial(block.invocationRef).catch((error: unknown) => {
                      Logger.warn(
                          `dispatchInteraction: could not present denial for ${block.blockId}: ${error instanceof Error ? error.message : String(error)}`,
                      )
                  })
              })()
            : undefined
    // When the command left text behind, the handler shows that text instead.
    // The row takes its place in the sequence now, ahead of anything the
    // answered dialog goes on to produce, but it is presentation: the runtime
    // already accepted the reply, so its command and receiver settle first and
    // a failed or slow write cannot strand either of them.
    const consumedRow = showsReply
        ? showConsumedReply(
              session.messages,
              session.owners.nextPresentationId,
              request,
              // The whole reply as the user typed it: only a command its owner
              // claimed acted, the rest reached the dialog as written.
              submittedInputRow(
                  [
                      {
                          text: request.draft?.text,
                          images: attachments.images,
                          files: attachments.files,
                          ...(draftDocument === undefined ? {} : { semanticInput: draftDocument }),
                      },
                  ],
                  {
                      admitted: false,
                      ...(reviewed?.claimedBarrier === undefined ? {} : { claimedBarrier: reviewed.claimedBarrier }),
                  },
              ),
          ).catch((error: unknown) => {
              Logger.warn(
                  `dispatchInteraction: could not show the reply for ${request.interactionId}: ${error instanceof Error ? error.message : String(error)}`,
              )
          })
        : undefined
    reviewed?.commit()
    const outcome: InteractionOutcome = {
        actionId: request.actionId as InteractionOutcome["actionId"],
        // That row is the reply's feedback; the handler's echo of the kept text
        // would only add an empty row after it.
        ...(replyConsumed ? { feedbackPresented: true } : {}),
        draft: request.draft
            ? {
                  text: draftText ?? request.draft.text,
                  images: [...attachments.images],
                  files: [...attachments.files],
                  // The same structure the payload holds: a continuation that
                  // re-admits the reply must not meet the claimed command again.
                  ...(storedDocument === undefined ? {} : { semanticInput: storedDocument }),
                  ...partsFieldOf(attachments),
              }
            : undefined,
        selection: request.selection ? { values: [...request.selection.values] } : undefined,
    }
    // An approval already continues through the kernel: `approval.responded`
    // runs the block, its result and the note recorded above are journaled, and
    // only then is the next round composed. It has no receiver, so handing it to
    // the interaction owner as well would treat it as an unowned dialog and
    // submit the note as new input, composing a round before the tool result
    // exists. Start New Task ends the task instead of answering the dialog.
    // Every other dialog still reaches its receiver or continuation.
    if (!approvalEntry && request.actionId === START_NEW_TASK_ACTION) closeForNewTask(controller, session)
    else if (!approvalEntry) session.owners.interactions.resolve(request.interactionId, outcome)
    await Promise.all([consumedRow, denialPresentation])
    return response(true, "accepted")
}

function hasDraftContent(draft: DispatchInteractionRequest["draft"], attachments: ReplyAttachments): boolean {
    return Boolean(
        draft &&
            (draft.text.trim().length > 0 ||
                attachments.images.length > 0 ||
                attachments.files.length > 0 ||
                attachments.admittedParts.some((part) => part.kind === "resource")),
    )
}
