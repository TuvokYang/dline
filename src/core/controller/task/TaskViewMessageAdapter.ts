import type { InteractionKind } from "@core/task/interaction/Interaction"
import { getInteraction, INTERACTION_KINDS } from "@core/task/interaction/InteractionRegistry"
import type {
	CanonicalDialogProjection,
	CanonicalTaskViewProjection,
} from "@core/task/view/canonical/CanonicalTaskViewProjection"
import type { ClineMessage, TaskInputViewState, TaskViewAction, TaskViewPhase, TaskViewState } from "@shared/ExtensionMessage"

const DISABLED_INPUT: TaskInputViewState = {
	enabled: false,
	acceptsText: false,
	acceptsImages: false,
	acceptsFiles: false,
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

/** Decorate one canonical Task projection with message-anchor and Webview presentation metadata. */
export function adaptCanonicalTaskView(view: CanonicalTaskViewProjection, messages: readonly ClineMessage[] = []): TaskViewState {
	const dialog = view.primary ?? view.approvals[0]
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
	const taskActions: TaskViewAction[] = view.taskActions.map((action) => ({
		type: "cancel",
		label: "Cancel",
		appearance: "danger",
		enabled: action.enabled,
		payloadPolicy: "none",
		dispatchTarget: "task",
	}))
	// Without its anchor row the dialog has nothing to pin its controls to, so the
	// surface falls back to task-level affordances instead of orphaned buttons.
	const anchored = Boolean(dialog && anchor)
	const input = dialog && kind && anchored ? projectInteractionInput(dialog, kind) : DISABLED_INPUT
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
		input,
		footer: { actions: anchored && interactionActions.length > 0 ? interactionActions : taskActions },
	}
}
