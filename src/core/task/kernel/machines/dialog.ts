import type { Command, DialogInteraction, DialogSlice, TaskEvent } from "../types"

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
			receiverGeneration: event.receiverGeneration,
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
		},
	}
}

export function reduceDialog(state: DialogSlice, event: TaskEvent, nextRevision: number): DialogReduction {
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
		return {
			state: {
				...state,
				primary: {
					interactionId,
					turnId: event.turnId ?? `error:${nextRevision}`,
					kind: "error_retry",
					status: "planned",
					createdRevision: nextRevision,
					presentationRef: interactionId,
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
	if (event.type === "dialog.resolved") {
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
