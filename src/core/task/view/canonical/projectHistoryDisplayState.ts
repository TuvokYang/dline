import type { UiMessage } from "@shared/ExtensionMessage"
import { getInteraction } from "../../interaction/InteractionRegistry"
import {
	createInitialTaskState,
	type DialogActionRule,
	type DialogInteraction,
	restorableApprovals,
	type TaskState,
} from "../../kernel"

/** Interaction a stopped task offers when it is rendered from history alone. */
export type HistoryDisplayInteractionKind = "resume" | "completion"

const ACTION_RULES: Readonly<Record<HistoryDisplayInteractionKind, readonly DialogActionRule[]>> = {
	resume: [{ actionId: "resume", payloadPolicy: "draft" }],
	completion: [
		{ actionId: "reply", payloadPolicy: "draft" },
		{ actionId: "start_new_task", payloadPolicy: "draft" },
	],
}

export interface HistoryDisplayProjection {
	readonly state: TaskState
	/**
	 * Present when the projection owns a synthesized interaction, so the caller
	 * must also supply the matching anchor row the durable history never wrote.
	 */
	readonly synthetic?: {
		readonly interactionId: string
		readonly kind: HistoryDisplayInteractionKind
	}
}

/**
 * The ask row a synthesized interaction anchors to, placed after the durable history.
 *
 * It exists only in the display: nothing is written until the user answers and
 * the task is promoted. A completed task asks to resume rather than replaying
 * its completion row.
 */
export function historyDisplayAnchorRow(
	synthetic: NonNullable<HistoryDisplayProjection["synthetic"]>,
	durableMessages: readonly UiMessage[],
): UiMessage {
	return {
		ts: durableMessages.reduce((latest, message) => Math.max(latest, message.ts), 0) + 1,
		type: "ask",
		ask: synthetic.kind === "completion" ? "resume_completed_task" : getInteraction(synthetic.kind).taskAsk,
		text: "",
		partial: false,
		interactionId: synthetic.interactionId,
	}
}

function ownedSnapshot(taskId: string, snapshot: TaskState | undefined): TaskState | undefined {
	return snapshot && snapshot.taskId === taskId ? snapshot : undefined
}

/**
 * A stopped task keeps its last dialog in a pre-reveal status because the
 * runtime that owned the prepare/reveal commands is gone. A read-only surface
 * has no runtime to advance it, so the durable interaction is presented as if
 * its reveal had completed. Responding still goes through the canonical Task,
 * which re-derives the authoritative status on resume.
 */
function revealedInteraction(snapshot: TaskState | undefined): DialogInteraction | undefined {
	const primary = snapshot?.dialog.primary
	if (!primary || primary.status === "failed") return undefined
	return { ...primary, status: "awaiting", receiverGeneration: primary.receiverGeneration ?? snapshot.generation }
}

function revealedApprovals(snapshot: TaskState | undefined): Readonly<Record<string, DialogInteraction>> {
	if (!snapshot) return {}
	return Object.fromEntries(
		Object.entries(restorableApprovals(snapshot)).map(([blockId, interaction]) => [
			blockId,
			{ ...interaction, status: "awaiting", receiverGeneration: interaction.receiverGeneration ?? snapshot.generation },
		]),
	)
}

/**
 * Project the read-only task state used to render a historical task without
 * starting its runtime, acquiring its lock, or writing any durable state.
 */
export function projectHistoryDisplayState(taskId: string, snapshot: TaskState | undefined): HistoryDisplayProjection {
	const owned = ownedSnapshot(taskId, snapshot)
	const base = owned ?? createInitialTaskState(taskId)
	// A consumed task handed its conversation to a successor. Like the kernel's
	// consumed hydrate form it is inert: history offers nothing to resume or answer.
	if (owned?.flow.terminalReason === "consumed") {
		return { state: { ...owned, dialog: { approvalsByBlock: {} } } }
	}
	const durable = revealedInteraction(owned)
	const approvals = revealedApprovals(owned)
	if (durable) {
		return { state: { ...base, dialog: { primary: durable, approvalsByBlock: approvals } } }
	}
	if (Object.keys(approvals).length > 0) {
		return {
			state: {
				...base,
				flow: { phase: "waiting" },
				dialog: { primary: undefined, approvalsByBlock: approvals },
			},
		}
	}

	const kind: HistoryDisplayInteractionKind = owned?.flow.phase === "completed" ? "completion" : "resume"
	const turnId = `history-display:${taskId}`
	const interactionId = `${turnId}:${kind}`
	const primary: DialogInteraction = {
		interactionId,
		turnId,
		kind,
		status: "awaiting",
		createdRevision: base.revision,
		presentationRef: `${kind}:${turnId}`,
		actionRules: ACTION_RULES[kind],
		receiverGeneration: base.generation,
	}
	return {
		state: {
			...base,
			flow:
				kind === "completion"
					? { ...base.flow, phase: "completed", completionId: base.flow.completionId ?? `${turnId}:completion` }
					: { ...base.flow, phase: "paused" },
			dialog: { primary, approvalsByBlock: {} },
		},
		synthetic: { interactionId, kind },
	}
}
