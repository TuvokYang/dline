import type { InteractionOutcome } from "@core/task/interaction/InteractionProtocol"
import type { MessageStateHandler } from "@core/task/message-state"
import { encodeTaskPayload } from "@core/task/stores/payload/TaskPayloadCodec"
import type { DialogDraftEnvelope, DialogSelectionEnvelope } from "@core/task/stores/payload/TaskPayloadEnvelopes"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { type DispatchInteractionRequest, DispatchInteractionResponse } from "@shared/proto/dline/task"
import { fromProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { Logger } from "@shared/services/Logger"
import type { Controller } from ".."

/** Stable protocol outcomes for expected interaction response races. */
type DispatchInteractionResult =
	| "accepted"
	| "stale_interaction"
	| "invalid_action"
	| "invalid_payload"
	| "duplicate_response"
	| "missing_task"
	| "invalid_runtime_event"

function response(accepted: boolean, result: DispatchInteractionResult): DispatchInteractionResponse {
	return DispatchInteractionResponse.create({ accepted, result })
}

/**
 * Decode the structure submitted with a reply, or report text only.
 *
 * Dropped rather than stored raw: the persisted draft is what a recovered
 * interaction replays, so it must not hold a structure no stage can validate.
 */
function decodeDraftDocument(request: DispatchInteractionRequest): SemanticInputDocument | undefined {
	const wire = request.draft?.semanticInput
	if (!wire) return undefined
	const decoded = fromProtoSemanticInputDocument(wire)
	if (decoded.ok) return decoded.document
	Logger.warn(`dispatchInteraction: dropping undecodable semantic input (${decoded.diagnostic.code})`)
	return undefined
}

/**
 * Show a reply whose lifecycle command consumed all of it, as the user typed it.
 *
 * The dialog handler echoes only the text a reply keeps; when the command took
 * everything, that is nothing, and the user's own row would never appear.
 * Keyed by the interaction so a replayed dispatch cannot show it twice, and
 * flushed before the reply is acknowledged: once the dialog is answered no
 * replay can recreate a row a crash dropped from the buffer.
 */
async function showConsumedReply(
	messages: MessageStateHandler,
	nextPresentationId: (() => number) | undefined,
	request: DispatchInteractionRequest,
): Promise<void> {
	const draft = request.draft
	const rowId = `reply:${request.interactionId}`
	if (!draft?.text || messages.clineMessages.some((row) => row.interactionId === rowId)) return
	// Rows are ordered by the session's shared sequence; drawing from it keeps
	// the reply ahead of the summary and the turn it causes.
	const lastTs = messages.clineMessages.at(-1)?.ts ?? 0
	const ts = nextPresentationId ? nextPresentationId() : Math.max(Date.now(), lastTs + 1)
	await messages.addToClineMessages({
		ts,
		type: "say",
		say: "user_feedback",
		text: draft.text,
		images: [...draft.images],
		files: [...draft.files],
		interactionId: rowId,
	})
	await messages.flushUiMessages()
}

function normalizeResult(reason: string): DispatchInteractionResult {
	if (reason === "identity_mismatch" || reason === "generation_mismatch" || reason === "stale_attempt")
		return "stale_interaction"
	if (reason === "duplicate") return "duplicate_response"
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
	if (request.taskId !== session.taskId || request.stateRevision !== state.revision) return response(false, "stale_interaction")
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
	if (!interaction || interaction.turnId !== request.turnId || interaction.status !== "awaiting")
		return response(false, "stale_interaction")
	if (!interaction.actionRules.some((rule) => rule.actionId === request.actionId)) return response(false, "invalid_action")
	if (interaction.receiverGeneration === undefined) return response(false, "invalid_runtime_event")

	const draftDocument = decodeDraftDocument(request)
	// A reply is user input like any submission: a lifecycle command typed into
	// it acts instead of reaching the model as literal feedback. What remains is
	// the text the reply keeps once the command and its premessage are taken out;
	// the command itself only acts once the runtime accepted the reply below.
	const reviewed = request.draft
		? await session.inputs.reviewReply({
				text: request.draft.text,
				images: [...request.draft.images],
				files: [...request.draft.files],
				...(draftDocument === undefined ? {} : { semanticInput: draftDocument }),
			})
		: undefined
	const draftText = request.draft ? (reviewed?.text ?? request.draft.text) : undefined
	const draftRef = request.draft
		? await session.payloads.put(
				encodeTaskPayload<DialogDraftEnvelope>({
					kind: "dialog_draft",
					text: draftText ?? request.draft.text,
					images: [...request.draft.images],
					files: [...request.draft.files],
					...(draftDocument === undefined ? {} : { semanticInput: draftDocument }),
				}),
			)
		: undefined
	const selectionRef = request.selection
		? await session.payloads.put(
				encodeTaskPayload<DialogSelectionEnvelope>({ kind: "dialog_selection", values: [...request.selection.values] }),
			)
		: undefined
	// An approval is planned from the turn, so its draft is not an intake entry.
	// Recording it against the block is the only route into the next provider
	// request; without it a note typed while approving is silently discarded.
	if (approvalEntry && request.draft) {
		session.approvalFeedback.record(approvalEntry[0], {
			text: draftText ?? request.draft.text,
			images: [...request.draft.images],
			files: [...request.draft.files],
		})
	}
	const result = approvalEntry
		? await session.task.respond({
				type: "approval.respond",
				taskId: session.taskId,
				turnId: interaction.turnId,
				interactionId: interaction.interactionId,
				stateRevision: state.revision,
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
				stateRevision: state.revision,
				receiverGeneration: interaction.receiverGeneration,
				actionId: request.actionId,
				draftRef,
				selectionRef,
			})
	if (result.kind === "rejected") return response(false, normalizeResult(result.reason))
	// When the command left text behind, the handler shows that text instead.
	if (reviewed && !reviewed.text) await showConsumedReply(session.messages, session.owners.nextPresentationId, request)
	reviewed?.commit()
	const outcome: InteractionOutcome = {
		actionId: request.actionId as InteractionOutcome["actionId"],
		draft: request.draft
			? {
					text: draftText ?? request.draft.text,
					images: [...request.draft.images],
					files: [...request.draft.files],
					...(draftDocument === undefined ? {} : { semanticInput: draftDocument }),
				}
			: undefined,
		selection: request.selection ? { values: [...request.selection.values] } : undefined,
	}
	session.owners.interactions.resolve(request.interactionId, outcome)
	return response(true, "accepted")
}
