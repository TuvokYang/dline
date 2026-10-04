import type { Command, CompactionFlowState, DialogInteraction, DialogSlice, TaskEvent } from "../types"

export interface DialogReduction {
	readonly state: DialogSlice
	readonly commands: readonly Command[]
}

type DialogProgressEvent = Extract<
	TaskEvent,
	{ type: "dialog.prepared" | "dialog.presented" | "dialog.failed" | "dialog.responded" | "dialog.reopened" }
>

type DialogRequestEvent = Extract<TaskEvent, { type: "dialog.requested" | "dialog.interrupt_requested" | "approval.requested" }>

function createInteraction(event: DialogRequestEvent, createdRevision: number): DialogInteraction {
	return {
		interactionId: event.interactionId,
		turnId: event.turnId,
		kind: event.kind,
		status: "planned",
		createdRevision,
		presentationRef: event.presentationRef,
		actionRules: event.actionRules,
		blockId: "blockId" in event ? event.blockId : undefined,
		prepareKey: `dialog.prepare:${event.interactionId}`,
	}
}

function updateInteraction(
	interaction: DialogInteraction | undefined,
	event: DialogProgressEvent,
	createdRevision: number,
): DialogInteraction | undefined {
	if (!interaction || interaction.interactionId !== event.interactionId) return interaction
	if (event.type === "dialog.prepared") {
		return {
			...interaction,
			status: "prepared",
			journalRef: event.journalRef,
			journalWatermark: event.journalWatermark,
			receiverGeneration: event.receiverGeneration,
			revealKey: `dialog.reveal:${event.interactionId}:${event.receiverGeneration}`,
			prepare: interaction.prepare && { ...interaction.prepare, status: "completed" },
		}
	}
	if (event.type === "dialog.presented")
		return {
			...interaction,
			status: "awaiting",
			reveal: interaction.reveal && { ...interaction.reveal, status: "completed" },
		}
	if (event.type === "dialog.failed") {
		return {
			...interaction,
			status: "failed",
			failure: { stage: event.stage, message: event.message },
			prepare:
				event.stage === "prepare" && interaction.prepare
					? { ...interaction.prepare, status: "failed" }
					: interaction.prepare,
			reveal:
				event.stage === "reveal" && interaction.reveal ? { ...interaction.reveal, status: "failed" } : interaction.reveal,
		}
	}
	if (event.type === "dialog.reopened") return { ...interaction, status: "awaiting", createdRevision }
	return {
		...interaction,
		status: "resolving",
		acceptedResponse: {
			actionId: event.actionId,
			stateRevision: event.stateRevision,
			receiverGeneration: event.receiverGeneration,
			draftRef: event.draftRef,
			selectionRef: event.selectionRef,
			...(event.queueDeliveryId && event.queueDeliveryEntries && event.queueDeliveryMode
				? {
						queuedInput: {
							deliveryId: event.queueDeliveryId,
							entries: event.queueDeliveryEntries,
							mode: event.queueDeliveryMode,
						},
					}
				: {}),
		},
	}
}

/**
 * Drop the review a compaction run opened once that run is abandoned.
 *
 * A run opens its review under its own compaction id, so the two share an
 * identity and nothing else. The review has no receiver once the run is gone:
 * leaving it primary kept the recovery offer from appearing and left a
 * Condense button that could no longer condense anything.
 */
export function withoutAbandonedReview(dialog: DialogSlice, compaction: CompactionFlowState | undefined): DialogSlice {
	if (compaction?.status !== "scheduled" && compaction?.status !== "running") return dialog
	if (dialog.primary?.turnId !== compaction.compactionId) return dialog
	return { ...dialog, primary: dialog.interrupted, interrupted: undefined }
}

export function reduceDialog(state: DialogSlice, event: TaskEvent, nextRevision: number): DialogReduction {
	if (
		(event.type === "tool.completed" || event.type === "tool.failed") &&
		state.primary?.interactionId === event.blockId &&
		state.primary.acceptedResponse?.queuedInput
	) {
		// The tool runner journals its result before terminal feedback. Keep the
		// accepted owner recoverable until that durable boundary, not just delivery.
		return { state: { ...state, primary: state.interrupted, interrupted: undefined }, commands: [] }
	}
	if (event.type === "provider.turn_ready") {
		const approvalsByBlock = { ...state.approvalsByBlock }
		for (const block of event.turnPlan.blocks) {
			if (block.approval.kind !== "manual") continue
			approvalsByBlock[block.blockId] = {
				interactionId: block.approval.interactionId,
				turnId: event.turnId,
				kind: "tool_approval",
				status: "planned",
				createdRevision: nextRevision,
				presentationRef: block.approval.presentationRef,
				actionRules: block.approval.actionRules,
				blockId: block.blockId,
				prepareKey: `dialog.prepare:${block.approval.interactionId}`,
			}
		}
		return { state: { ...state, approvalsByBlock }, commands: [] }
	}
	if (event.type === "dialog.requested") {
		return { state: { ...state, primary: createInteraction(event, nextRevision) }, commands: [] }
	}
	if (event.type === "dialog.interrupt_requested") {
		return {
			state: { ...state, primary: createInteraction(event, nextRevision), interrupted: state.primary },
			commands: [],
		}
	}
	if (event.type === "approval.requested") {
		return {
			state: {
				...state,
				approvalsByBlock: {
					...state.approvalsByBlock,
					[event.blockId]: createInteraction(event, nextRevision),
				},
			},
			commands: [],
		}
	}
	if ((event.type === "provider.failed" || event.type === "compose.failed") && !state.primary) {
		const interactionId = `error:${event.type}:${nextRevision}`
		// The chat renders the presentation as the failure itself, so a provider
		// that described it (an invalid Profile, a quota) is shown in its own
		// words; the interaction id is only a fallback that names no cause.
		const presentation = event.type === "provider.failed" ? event.presentation : undefined
		return {
			state: {
				...state,
				primary: {
					interactionId,
					turnId: event.turnId ?? `error:${nextRevision}`,
					kind: "error_retry",
					status: "planned",
					createdRevision: nextRevision,
					presentationRef: presentation ?? interactionId,
					actionRules: [
						{ actionId: "retry", payloadPolicy: "draft" },
						{ actionId: "start_new_task", payloadPolicy: "draft" },
					],
				},
			},
			commands: [],
		}
	}
	if (event.type === "approval.evaluated") {
		const { [event.blockId]: _resolved, ...approvalsByBlock } = state.approvalsByBlock
		return { state: { ...state, approvalsByBlock }, commands: [] }
	}
	if (event.type === "dialog.resolved" || event.type === "dialog.dismissed") {
		const resolvingPrimary = state.primary?.interactionId === event.interactionId
		const primary = resolvingPrimary ? state.interrupted : state.primary
		const interrupted = resolvingPrimary ? undefined : state.interrupted
		const approvalsByBlock = Object.fromEntries(
			Object.entries(state.approvalsByBlock).filter(([, interaction]) => interaction.interactionId !== event.interactionId),
		)
		return { state: { ...state, primary, interrupted, approvalsByBlock }, commands: [] }
	}
	if (
		event.type !== "dialog.prepared" &&
		event.type !== "dialog.presented" &&
		event.type !== "dialog.failed" &&
		event.type !== "dialog.responded" &&
		event.type !== "dialog.reopened"
	) {
		return { state, commands: [] }
	}
	const primary = updateInteraction(state.primary, event, nextRevision)
	const approvalsByBlock = Object.fromEntries(
		Object.entries(state.approvalsByBlock).map(([blockId, interaction]) => [
			blockId,
			updateInteraction(interaction, event, nextRevision) ?? interaction,
		]),
	)
	return { state: { ...state, primary, approvalsByBlock }, commands: [] }
}
