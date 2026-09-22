import type { InteractionOutcome } from "@core/task/interaction/InteractionProtocol"
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
	const primary = state.dialog.primary?.interactionId === request.interactionId ? state.dialog.primary : undefined
	const approvalEntry = Object.entries(state.dialog.approvalsByBlock).find(
		([, interaction]) => interaction.interactionId === request.interactionId,
	)
	const interaction = primary ?? approvalEntry?.[1]
	if (!interaction || interaction.turnId !== request.turnId || interaction.status !== "awaiting")
		return response(false, "stale_interaction")
	if (!interaction.actionRules.some((rule) => rule.actionId === request.actionId)) return response(false, "invalid_action")
	if (interaction.receiverGeneration === undefined) return response(false, "invalid_runtime_event")

	const draftDocument = decodeDraftDocument(request)
	const draftRef = request.draft
		? await session.payloads.put(
				encodeTaskPayload<DialogDraftEnvelope>({
					kind: "dialog_draft",
					text: request.draft.text,
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
	const outcome: InteractionOutcome = {
		actionId: request.actionId as InteractionOutcome["actionId"],
		draft: request.draft
			? {
					text: request.draft.text,
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
