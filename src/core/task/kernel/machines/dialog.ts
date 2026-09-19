import type { Command, DialogInteraction, DialogSlice, TaskEvent } from "../types"

export interface DialogReduction {
	readonly state: DialogSlice
	readonly commands: readonly Command[]
}

type DialogProgressEvent = Extract<TaskEvent, { type: "dialog.prepared" | "dialog.presented" | "dialog.responded" }>

function updateInteraction(
	interaction: DialogInteraction | undefined,
	event: DialogProgressEvent,
): DialogInteraction | undefined {
	if (!interaction || interaction.interactionId !== event.interactionId) return interaction
	if (event.type === "dialog.prepared")
		return { ...interaction, status: "prepared", journalRef: event.journalRef, receiverGeneration: event.receiverGeneration }
	if (event.type === "dialog.presented") return { ...interaction, status: "presented" }
	return { ...interaction, status: "responded", payloadRef: event.payloadRef, actionId: event.actionId }
}

export function reduceDialog(state: DialogSlice, event: TaskEvent): DialogReduction {
	if (event.type === "dialog.requested") {
		const interaction: DialogInteraction = {
			interactionId: event.interactionId,
			kind: event.kind,
			status: "planned",
			blockId: event.blockId,
		}
		return event.blockId
			? { state: { ...state, approvalsByBlock: { ...state.approvalsByBlock, [event.blockId]: interaction } }, commands: [] }
			: { state: { ...state, primary: interaction }, commands: [] }
	}
	if (event.type === "approval.requested") {
		const interaction: DialogInteraction = {
			interactionId: event.interactionId,
			kind: event.kind,
			status: "planned",
			blockId: event.blockId,
		}
		return {
			state: { ...state, approvalsByBlock: { ...state.approvalsByBlock, [event.blockId]: interaction } },
			commands: [],
		}
	}
	if (event.type === "approval.responded") {
		const current = state.approvalsByBlock[event.blockId]
		return current?.interactionId === event.interactionId
			? {
					state: {
						...state,
						approvalsByBlock: { ...state.approvalsByBlock, [event.blockId]: { ...current, status: "responded" } },
					},
					commands: [],
				}
			: { state, commands: [] }
	}
	if (event.type === "dialog.resolved") {
		const primary = state.primary?.interactionId === event.interactionId ? undefined : state.primary
		const approvalsByBlock = Object.fromEntries(
			Object.entries(state.approvalsByBlock).filter(([, interaction]) => interaction.interactionId !== event.interactionId),
		)
		return { state: { ...state, primary, approvalsByBlock }, commands: [] }
	}
	if (event.type !== "dialog.prepared" && event.type !== "dialog.presented" && event.type !== "dialog.responded")
		return { state, commands: [] }
	const primary = updateInteraction(state.primary, event)
	const approvalsByBlock = Object.fromEntries(
		Object.entries(state.approvalsByBlock).map(([blockId, interaction]) => [
			blockId,
			updateInteraction(interaction, event) ?? interaction,
		]),
	)
	return { state: { ...state, primary, approvalsByBlock }, commands: [] }
}
