import type { InteractionKind } from "@core/task/interaction/Interaction"
import { getInteraction, INTERACTION_KINDS } from "@core/task/interaction/InteractionRegistry"
import type {
	CanonicalDialogProjection,
	CanonicalTaskViewProjection,
} from "@core/task/view/canonical/CanonicalTaskViewProjection"
import type { TaskInputViewState, TaskViewAction, TaskViewPhase, TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { type BackgroundHandoffAvailabilityPort, projectBackgroundHandoffAction } from "./BackgroundHandoffAvailability"

const DISABLED_INPUT: TaskInputViewState = {
	enabled: false,
	acceptsText: false,
	acceptsImages: false,
	acceptsFiles: false,
}

/** Sends the scheduled automatic retry now; dispatched to the task, not to a dialog. */
const AUTOMATIC_RETRY_ACTION: TaskViewAction = {
	type: "retry",
	label: "Retry",
	appearance: "primary",
	enabled: true,
	payloadPolicy: "none",
	dispatchTarget: "task",
}

function taskViewPhase(view: CanonicalTaskViewProjection): TaskViewPhase {
	if (view.activity === "halting") return "cancelling"
	switch (view.flowPhase) {
		case "running":
			return view.approvals.length > 0 ? "awaiting_approval" : "streaming"
		case "waiting":
			return "between_turns"
		case "error":
			return "paused"
		case "terminated":
			return "aborted"
		default:
			return view.flowPhase
	}
}

function interactionKind(kind: string): InteractionKind | undefined {
	return (INTERACTION_KINDS as readonly string[]).includes(kind) ? (kind as InteractionKind) : undefined
}

function projectInteractionActions(dialog: CanonicalDialogProjection, kind: InteractionKind): TaskViewAction[] {
	const definition = getInteraction(kind)
	const rules = new Map(dialog.actions.map((action) => [action.actionId, action]))
	return definition.actions.flatMap((action) => {
		const rule = rules.get(action.type)
		return rule
			? [{ ...action, enabled: rule.enabled, payloadPolicy: rule.payloadPolicy, dispatchTarget: "interaction" as const }]
			: []
	})
}

function projectInteractionInput(dialog: CanonicalDialogProjection, kind: InteractionKind): TaskInputViewState {
	const definition = getInteraction(kind)
	const enterAction = definition.input.enterAction
	const enterEnabled = enterAction
		? dialog.actions.some((action) => action.actionId === enterAction && action.enabled)
		: dialog.status === "awaiting"
	return { ...definition.input, enabled: definition.input.enabled && enterEnabled }
}

/**
 * Select the dialog the canonical projection already assigned the input to.
 *
 * Taking the primary dialog unconditionally hid a live approval behind a primary
 * that had been answered and was still resolving: the input went to the
 * approval while the footer and anchor described the spent primary, so its
 * Approve and Reject controls never rendered.
 */
function owningDialog(view: CanonicalTaskViewProjection): CanonicalDialogProjection | undefined {
	const ownerInteractionId = view.input.mode === "dialog" ? view.input.ownerInteractionId : undefined
	const candidates = [view.primary, view.interrupted, ...view.approvals]
	const owner = ownerInteractionId ? candidates.find((candidate) => candidate?.interactionId === ownerInteractionId) : undefined
	// An interrupted task has no live primary; its recovery dialog is the one the
	// surface must anchor, otherwise Resume renders without a dispatch target.
	return owner ?? view.primary ?? view.interrupted ?? view.approvals[0]
}

/** Decorate one canonical Task projection with message-anchor and Webview presentation metadata. */
export function adaptCanonicalTaskView(
	view: CanonicalTaskViewProjection,
	messages: readonly UiMessage[] = [],
	handoff?: BackgroundHandoffAvailabilityPort,
	automaticRetry = false,
	truncationOffered = false,
): TaskViewState {
	const dialog = owningDialog(view)
	const kind = dialog ? interactionKind(dialog.kind) : undefined
	// A still-partial row means the reveal never finished, so it cannot anchor a
	// dispatchable interaction.
	const anchors = dialog
		? messages.filter(
				(message) => message.type === "ask" && message.interactionId === dialog.interactionId && !message.partial,
			)
		: []
	const anchor = anchors.length === 1 ? anchors[0] : undefined
	const definition = kind ? getInteraction(kind) : undefined
	const activeInteraction =
		dialog && definition && anchor
			? {
					taskId: view.taskId,
					turnId: dialog.turnId,
					interactionId: dialog.interactionId,
					kind: dialog.kind,
					status:
						dialog.status === "awaiting"
							? ("awaiting" as const)
							: dialog.status === "resolving"
								? ("resolving" as const)
								: ("opening" as const),
					stateRevision: view.revision,
					taskAsk: anchor.ask ?? definition.taskAsk,
					presentationKind: kind === "change_todo_list" ? "focus_chain_change" : definition.presentationKind,
					askMessageTs: anchor.ts,
					anchorVerified: true,
				}
			: undefined
	const interactionActions = dialog && kind ? projectInteractionActions(dialog, kind) : []
	const cancelActions: TaskViewAction[] = view.taskActions.map((action) => ({
		type: "cancel",
		label: "Cancel",
		appearance: "danger",
		enabled: action.enabled,
		payloadPolicy: "none",
		dispatchTarget: "task",
	}))
	// A synchronous command that outlived its handoff wait can be moved to the
	// background instead of cancelled, so that choice is offered before Cancel.
	// The affordance disappears again once the executor no longer owns it.
	const handoffAction = cancelActions.length > 0 ? projectBackgroundHandoffAction(handoff) : undefined
	// While an automatic retry owns the request, Retry sends the next attempt
	// now instead of waiting out the countdown, as the previous runtime offered.
	const retryActions: TaskViewAction[] = automaticRetry ? [{ ...AUTOMATIC_RETRY_ACTION }] : []
	const taskActions: TaskViewAction[] = [...retryActions, ...(handoffAction ? [handoffAction] : []), ...cancelActions]
	// Without its anchor row the dialog has nothing to pin its controls to, so the
	// surface falls back to task-level affordances instead of orphaned buttons.
	const anchored = Boolean(dialog && anchor)
	const input = dialog && kind && anchored ? projectInteractionInput(dialog, kind) : DISABLED_INPUT
	// Truncation destroys history, so it is offered only beside the Retry it
	// replaces: the round a failed automatic compaction stopped, awaiting the user.
	const forceTruncateAvailable = truncationOffered && anchored && dialog?.kind === "error_retry" && dialog.status === "awaiting"
	return {
		taskId: view.taskId,
		phase: taskViewPhase(view),
		stateRevision: view.revision,
		activeInteraction,
		...(dialog && !anchor
			? { diagnostic: { code: "interaction_anchor_missing" as const, interactionId: dialog.interactionId } }
			: {}),
		...(view.compaction?.status === "scheduled" || view.compaction?.status === "running"
			? { contextCompaction: { active: true as const, operationId: view.compaction.compactionId } }
			: {}),
		...(forceTruncateAvailable ? { forceTruncateAvailable: true } : {}),
		input,
		footer: { actions: anchored && interactionActions.length > 0 ? interactionActions : taskActions },
	}
}
