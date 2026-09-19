import { reduceDialog } from "./machines/dialog"
import { reduceFlow } from "./machines/flow"
import { ALL_HALT_PARTICIPANTS, reduceHalt } from "./machines/halt"
import { reduceIntake } from "./machines/intake"
import { reduceTurn } from "./machines/turn"
import type { Command, Diagnostic, RejectReason, TaskEvent, TaskState, TransitionResult } from "./types"

function reject(state: TaskState, reason: RejectReason, message: string): TransitionResult {
	return { kind: "rejected", state, reason, diagnostic: { code: reason, message } }
}

function commandBase(state: TaskState, sequence: number) {
	return {
		commandId: `${state.taskId}:${state.revision}:${sequence}`,
		originRevision: state.revision,
		generation: state.generation,
	}
}

type ValidationFailure = { readonly reason: RejectReason; readonly message: string }

function findInteraction(state: TaskState, interactionId: string) {
	if (state.dialog.primary?.interactionId === interactionId) return state.dialog.primary
	if (state.dialog.interrupted?.interactionId === interactionId) return state.dialog.interrupted
	return Object.values(state.dialog.approvalsByBlock).find((interaction) => interaction.interactionId === interactionId)
}

function hasRequiredPayload(
	policy: "none" | "draft" | "selection" | "draft_and_selection",
	event: Extract<TaskEvent, { type: "dialog.responded" }>,
): boolean {
	if (policy === "none") return true
	if (policy === "draft") return event.draftRef !== undefined
	if (policy === "selection") return event.selectionRef !== undefined
	return event.draftRef !== undefined && event.selectionRef !== undefined
}

function validateEvent(state: TaskState, event: TaskEvent): ValidationFailure | undefined {
	if (event.type === "user.submit" || event.type === "background.ready" || event.type === "cotask.received") {
		const entries =
			event.type === "user.submit"
				? state.intake.queued
				: event.type === "background.ready"
					? state.intake.background
					: state.intake.coTask
		if (entries.some((entry) => entry.entryId === event.entryId))
			return { reason: "duplicate", message: `Entry ${event.entryId} already exists` }
	}
	if ((event.type === "user.cancel" || event.type === "user.terminate") && state.halt.status === "stopping") {
		return { reason: "duplicate", message: `Halt ${state.halt.haltId} is already in progress` }
	}
	if (event.type === "halt.halted" || event.type === "halt.failed") {
		if (state.halt.status !== "stopping" || state.halt.haltId !== event.haltId)
			return { reason: "identity_mismatch", message: `Halt ${event.haltId} is not active` }
		if (!state.halt.pending.includes(event.participantId))
			return { reason: "duplicate", message: `${event.participantId} already acknowledged halt ${event.haltId}` }
	}
	if (event.type.startsWith("tool.")) {
		const toolEvent = event as Extract<
			TaskEvent,
			{ type: "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled" }
		>
		if (state.turn.turnId !== toolEvent.turnId)
			return { reason: "identity_mismatch", message: `Turn ${toolEvent.turnId} is not active` }
		const block = state.turn.blocks.find((candidate) => candidate.blockId === toolEvent.blockId)
		if (!block) return { reason: "identity_mismatch", message: `Block ${toolEvent.blockId} is not active` }
		if (block.attempt !== toolEvent.attempt)
			return { reason: "stale_attempt", message: `Attempt ${toolEvent.attempt ?? "missing"} is stale` }
		if (toolEvent.type === "tool.started" && block.phase !== "ready")
			return {
				reason: block.phase === "executing" ? "duplicate" : "phase_invalid",
				message: `Block ${block.blockId} cannot start from ${block.phase}`,
			}
		if (toolEvent.type !== "tool.started" && block.phase !== "executing")
			return {
				reason: TERMINAL_BLOCK_PHASES.has(block.phase) ? "duplicate" : "phase_invalid",
				message: `Block ${block.blockId} cannot finish from ${block.phase}`,
			}
	}
	if (event.type === "approval.requested") {
		if (state.turn.turnId !== event.turnId || !state.turn.blocks.some((block) => block.blockId === event.blockId))
			return { reason: "identity_mismatch", message: `Approval block ${event.blockId} is not active` }
		if (state.turn.manualApprovalBlockId)
			return { reason: "phase_invalid", message: `Approval slot is owned by ${state.turn.manualApprovalBlockId}` }
		if (state.turn.blocks.find((block) => block.blockId === event.blockId)?.phase !== "pending")
			return { reason: "phase_invalid", message: `Block ${event.blockId} is not pending` }
	}
	if (event.type === "approval.responded") {
		const block = state.turn.blocks.find((candidate) => candidate.blockId === event.blockId)
		const interaction = state.dialog.approvalsByBlock[event.blockId]
		if (state.turn.turnId !== event.turnId || !block || interaction?.interactionId !== event.interactionId)
			return { reason: "identity_mismatch", message: `Approval block ${event.blockId} is not active` }
		if (
			state.turn.manualApprovalBlockId !== event.blockId ||
			block.phase !== "awaiting_approval" ||
			interaction.status !== "resolving"
		)
			return { reason: "phase_invalid", message: `Block ${event.blockId} is not awaiting a resolved approval` }
	}
	if (event.type === "approval.evaluated") {
		const block = state.turn.blocks.find((candidate) => candidate.blockId === event.blockId)
		if (!block) return { reason: "identity_mismatch", message: `Policy block ${event.blockId} is not active` }
		if (block.phase !== "pending")
			return {
				reason: block.phase === "ready" ? "duplicate" : "phase_invalid",
				message: `Block ${event.blockId} cannot be policy-approved from ${block.phase}`,
			}
	}
	if (event.type === "dialog.requested" || event.type === "dialog.interrupt_requested") {
		if (findInteraction(state, event.interactionId))
			return { reason: "duplicate", message: `Interaction ${event.interactionId} already exists` }
		if (event.type === "dialog.requested" && state.dialog.primary)
			return { reason: "phase_invalid", message: `Primary interaction ${state.dialog.primary.interactionId} is active` }
		if (
			event.type === "dialog.interrupt_requested" &&
			(state.dialog.primary?.status !== "awaiting" || state.dialog.interrupted)
		)
			return { reason: "phase_invalid", message: "Only one awaiting primary interaction can be interrupted" }
	}
	if (event.type === "approval.requested" && findInteraction(state, event.interactionId))
		return { reason: "duplicate", message: `Interaction ${event.interactionId} already exists` }
	if (
		event.type === "dialog.prepared" ||
		event.type === "dialog.presented" ||
		event.type === "dialog.responded" ||
		event.type === "dialog.reopened" ||
		event.type === "dialog.resolved"
	) {
		const interaction = findInteraction(state, event.interactionId)
		if (!interaction) return { reason: "identity_mismatch", message: `Interaction ${event.interactionId} is not active` }
		if (event.type === "dialog.prepared" && interaction.status !== "planned")
			return {
				reason: interaction.status === "prepared" ? "duplicate" : "phase_invalid",
				message: "Interaction is not planned",
			}
		if (event.type === "dialog.presented" && interaction.status !== "prepared")
			return {
				reason: interaction.status === "awaiting" ? "duplicate" : "phase_invalid",
				message: "Interaction is not prepared",
			}
		if (event.type === "dialog.reopened" && interaction.status !== "resolving")
			return { reason: "phase_invalid", message: "Only a resolving interaction can be reopened" }
		if (
			event.type === "dialog.resolved" &&
			interaction.status !== "resolving" &&
			!(interaction.status === "awaiting" && interaction.acceptedResponse)
		)
			return { reason: "phase_invalid", message: "Interaction has no committed response to resolve" }
		if (event.type === "dialog.responded") {
			if (
				event.taskId !== state.taskId ||
				event.turnId !== interaction.turnId ||
				event.stateRevision < interaction.createdRevision ||
				event.stateRevision > state.revision ||
				event.receiverGeneration !== interaction.receiverGeneration
			)
				return { reason: "identity_mismatch", message: "Interaction response is outside its causal window" }
			if (interaction.status !== "awaiting")
				return {
					reason: interaction.status === "resolving" ? "duplicate" : "phase_invalid",
					message: "Interaction is not awaiting response",
				}
			const rule = interaction.actionRules.find((candidate) => candidate.actionId === event.actionId)
			if (!rule) return { reason: "identity_mismatch", message: `Action ${event.actionId} is not valid` }
			if (!hasRequiredPayload(rule.payloadPolicy, event))
				return { reason: "phase_invalid", message: `Action ${event.actionId} is missing required payload` }
		}
	}
	if (event.type === "lifecycle.open" && state.flow.phase !== "idle")
		return { reason: "phase_invalid", message: `Task cannot open from ${state.flow.phase}` }
	return undefined
}

const TERMINAL_BLOCK_PHASES = new Set(["completed", "failed", "rejected", "skipped", "cancelled"])

function deriveCommands(previous: TaskState, next: TaskState, event: TaskEvent): readonly Command[] {
	if (event.type === "user.cancel" || event.type === "user.terminate") {
		return [
			{
				...commandBase(next, 0),
				type: "halt.stop",
				haltId: event.haltId,
				participantIds: ALL_HALT_PARTICIPANTS,
				reason: event.type === "user.terminate" ? "terminate" : "cancel",
			},
		]
	}
	if (event.type === "approval.requested" || event.type === "dialog.requested" || event.type === "dialog.interrupt_requested") {
		return [{ ...commandBase(next, 0), type: "dialog.prepare", interactionId: event.interactionId, kind: event.kind }]
	}
	if (event.type === "dialog.prepared") {
		return [
			{ ...commandBase(next, 0), type: "dialog.reveal", interactionId: event.interactionId, journalRef: event.journalRef },
		]
	}
	if ((event.type === "approval.evaluated" || event.type === "approval.responded") && event.approved) {
		const before = previous.turn.blocks.find((block) => block.blockId === event.blockId)
		const after = next.turn.blocks.find((block) => block.blockId === event.blockId)
		if (before?.phase !== "ready" && after?.phase === "ready" && next.turn.turnId) {
			return [{ ...commandBase(next, 0), type: "tool.run", turnId: next.turn.turnId, blockIds: [event.blockId] }]
		}
	}
	if (event.type === "user.submit" && previous.flow.phase !== "terminated") {
		return [{ ...commandBase(next, 0), type: "compose.round", turnId: next.turn.turnId, admittedEntryIds: [event.entryId] }]
	}
	return []
}

export function transition(state: TaskState, event: TaskEvent): TransitionResult {
	if (event.generation !== state.generation)
		return reject(state, "generation_mismatch", `Event generation ${event.generation} does not match ${state.generation}`)
	if (state.flow.phase === "terminated" && event.type !== "lifecycle.open")
		return reject(state, "phase_invalid", "Terminated tasks reject new events")
	const invalid = validateEvent(state, event)
	if (invalid) return reject(state, invalid.reason, invalid.message)

	const nextRevision = state.revision + 1
	const flow = reduceFlow(state.flow, event)
	const turn = reduceTurn(state.turn, event)
	const dialog = reduceDialog(state.dialog, event, nextRevision)
	const intake = reduceIntake(state.intake, event)
	const halt = reduceHalt(state.halt, event)
	let next: TaskState = {
		...state,
		revision: nextRevision,
		flow: flow.state,
		turn: turn.state,
		dialog: dialog.state,
		intake: intake.state,
		halt: halt.state,
	}
	if (halt.state.status === "stopping" && halt.state.pending.length === 0) {
		next = { ...next, flow: { phase: halt.state.target }, halt: { status: "idle", generation: halt.state.generation } }
	}
	if (
		event.type === "approval.responded" &&
		!event.approved &&
		next.turn.blocks.length > 0 &&
		next.turn.blocks.every((block) => ["completed", "failed", "rejected", "skipped", "cancelled"].includes(block.phase))
	) {
		next = { ...next, flow: { phase: "waiting" } }
	}
	const commands = [
		...flow.commands,
		...turn.commands,
		...dialog.commands,
		...intake.commands,
		...halt.commands,
		...deriveCommands(state, next, event),
	]
	return { kind: "accepted", state: next, commands }
}

export function diagnostic(code: string, message: string): Diagnostic {
	return { code, message }
}
