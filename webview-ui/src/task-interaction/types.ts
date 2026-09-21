import type { ClineMessage, TaskViewActionType, TaskViewState } from "@shared/ExtensionMessage"
import { matchesActiveInteractionAnchor } from "@shared/interaction-anchor"
import type { DispatchInteractionRequest, DispatchInteractionResponse } from "@shared/proto/dline/task"

/** Complete Webview draft snapshot owned by the chat composition root. */
export interface InteractionDraft {
	text: string
	images: string[]
	files: string[]
	activeQuote?: string | null
	ownerRevision?: number
}

/** Capture mutable draft values before dispatching an interaction. */
export function captureInteractionDraft(draft: InteractionDraft): InteractionDraft {
	return {
		text: draft.text,
		images: [...draft.images],
		files: [...draft.files],
		activeQuote: draft.activeQuote ?? null,
		ownerRevision: draft.ownerRevision,
	}
}

/** Compare complete draft ownership state before applying an accepted settlement. */
export function isSameInteractionDraft(current: InteractionDraft, captured: InteractionDraft): boolean {
	return (
		current.text === captured.text &&
		current.activeQuote === captured.activeQuote &&
		current.ownerRevision === captured.ownerRevision &&
		current.images.length === captured.images.length &&
		current.images.every((image, index) => image === captured.images[index]) &&
		current.files.length === captured.files.length &&
		current.files.every((file, index) => file === captured.files[index])
	)
}

/** Accepted New Task approval retained until the matching successor surface is stable. */
export interface PendingSuccessorDraftTransfer {
	readonly sourceTaskId: string
	readonly context: string
	readonly draft: InteractionDraft
}

/** Accepted interaction identity and exact draft snapshot returned to the composition owner. */
export interface AcceptedInteractionSettlement {
	readonly taskId: string
	readonly turnId: string
	readonly interactionId: string
	readonly stateRevision: number
	readonly draft: InteractionDraft
}

/** Selection values owned by selection-aware presentation renderers. */
export interface InteractionSelection {
	values: string[]
}

/** Create an immutable accepted settlement from the exact dispatched request. */
export function createAcceptedInteractionSettlement(
	request: DispatchInteractionRequest,
	draft: InteractionDraft,
): AcceptedInteractionSettlement {
	return {
		taskId: request.taskId,
		turnId: request.turnId,
		interactionId: request.interactionId,
		stateRevision: request.stateRevision,
		draft: captureInteractionDraft(draft),
	}
}

/** Guard the composition owner against stale accepted responses. */
export function canApplyAcceptedInteractionSettlement(
	currentTaskId: string | undefined,
	currentDraft: InteractionDraft,
	settlement: AcceptedInteractionSettlement,
): boolean {
	return currentTaskId === settlement.taskId && isSameInteractionDraft(currentDraft, settlement.draft)
}

/** Whether a draft holds nothing the user would lose by overwriting it. */
function isEmptyInteractionDraft(draft: InteractionDraft): boolean {
	return draft.text === "" && draft.images.length === 0 && draft.files.length === 0
}

/** Local evidence used to fence a delayed rollback without guessing from feedback text. */
export interface DraftRollbackEvidence {
	currentEpoch: number
	submissionEpoch: number
	messages: readonly ClineMessage[]
}

/**
 * Guard the rollback that follows a rejected dispatch.
 *
 * Every submit path clears optimistically, so a rejection has to put the
 * submitted draft back or the user silently loses it. The owner revision has
 * already moved on by then, which is why this cannot reuse the accepted-
 * settlement guard: restoring is safe exactly while the composer is still
 * empty. Anything typed during the round trip is newer and must win.
 */
export function canRestoreRejectedInteractionDraft(
	currentTaskId: string | undefined,
	currentDraft: InteractionDraft,
	settlement: AcceptedInteractionSettlement,
	evidence?: DraftRollbackEvidence,
): boolean {
	if (evidence?.currentEpoch !== evidence?.submissionEpoch) return false
	if (
		settlement.interactionId &&
		evidence?.messages.some(
			(message) =>
				message.type === "say" && message.say === "user_feedback" && message.interactionId === settlement.interactionId,
		)
	) {
		return false
	}
	return currentTaskId === settlement.taskId && isEmptyInteractionDraft(currentDraft)
}

/** Injectable causal protocol boundary used by interaction components. */
export type DispatchInteraction = (request: DispatchInteractionRequest) => Promise<DispatchInteractionResponse>

/** Resolve the exact ask row owned by the projected active interaction. */
export function findActiveInteractionAnchor(messages: readonly ClineMessage[], view: TaskViewState): ClineMessage | undefined {
	const interaction = view.activeInteraction
	if (!interaction) {
		return undefined
	}
	const matches = messages.filter((message) => matchesActiveInteractionAnchor(message, interaction))
	return matches.length === 1 ? matches[0] : undefined
}

/** A view without an active interaction needs no ask anchor; active interactions must match exactly. */
export function isActiveInteractionSynchronized(messages: readonly ClineMessage[], view: TaskViewState): boolean {
	return !view.activeInteraction || Boolean(findActiveInteractionAnchor(messages, view))
}

/** Build one causal request from the current backend projection. */
export function buildInteractionRequest(
	view: TaskViewState,
	actionId: TaskViewActionType,
	draft: InteractionDraft,
	selection?: InteractionSelection,
): DispatchInteractionRequest | undefined {
	const interaction = view.activeInteraction
	if (!interaction) {
		return undefined
	}
	const action = view.footer.actions.find(
		(candidate) => candidate.type === actionId && candidate.dispatchTarget === "interaction",
	)
	const carriesDraft = action
		? action.payloadPolicy === "draft" || action.payloadPolicy === "draft_and_selection"
		: view.input.enterAction === actionId
	return {
		taskId: interaction.taskId,
		turnId: interaction.turnId,
		interactionId: interaction.interactionId,
		actionId,
		stateRevision: interaction.stateRevision,
		draft: carriesDraft ? { text: draft.text, images: [...draft.images], files: [...draft.files] } : undefined,
		selection: selection ? { values: [...selection.values] } : undefined,
	}
}
