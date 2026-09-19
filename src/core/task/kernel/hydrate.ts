import type {
	Command,
	Diagnostic,
	DialogActionRule,
	DialogInteraction,
	HydrateForm,
	HydrateInput,
	HydrateResult,
	TaskState,
} from "./types"
import { createInitialTaskState } from "./types"

interface JournalPosition {
	readonly epoch: number
	readonly seq: number
}

function readOnly(reason: string, code: string, message: string): HydrateResult {
	return { kind: "read_only", reason, diagnostics: [{ code, message }] }
}

function parseJournalRef(ref: string): JournalPosition | undefined {
	const match = ref.match(/^journal:(?:(\d+):)?(\d+)$/)
	if (!match) return undefined
	return { epoch: Number(match[1] ?? 0), seq: Number(match[2]) }
}

function isAfter(position: JournalPosition, tail: JournalPosition): boolean {
	return position.epoch > tail.epoch || (position.epoch === tail.epoch && position.seq > tail.seq)
}

function interactions(state: TaskState): readonly DialogInteraction[] {
	return [state.dialog.primary, state.dialog.interrupted, ...Object.values(state.dialog.approvalsByBlock)].filter(
		(interaction): interaction is DialogInteraction => interaction !== undefined,
	)
}

function validateSnapshot(input: HydrateInput, snapshot: TaskState): HydrateResult | undefined {
	if (snapshot.taskId !== input.taskId)
		return readOnly("task_identity_mismatch", "task_identity_mismatch", "Snapshot belongs to another task")
	if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0)
		return readOnly("snapshot_invalid", "invalid_revision", "Snapshot revision is invalid")
	if (!Number.isInteger(snapshot.generation) || snapshot.generation < 0 || snapshot.halt.generation !== snapshot.generation)
		return readOnly("snapshot_invalid", "invalid_generation", "Snapshot generation is inconsistent")

	const blockIds = new Set<string>()
	const indexes = new Set<number>()
	for (const block of snapshot.turn.blocks) {
		if (blockIds.has(block.blockId) || indexes.has(block.index))
			return readOnly("snapshot_invalid", "duplicate_block_identity", "Snapshot contains duplicate block identity")
		blockIds.add(block.blockId)
		indexes.add(block.index)
	}
	const ownedBlockIds = [
		...snapshot.turn.executingBlockIds,
		...snapshot.turn.automaticApprovalBlockIds,
		...(snapshot.turn.manualApprovalBlockId ? [snapshot.turn.manualApprovalBlockId] : []),
	]
	if (ownedBlockIds.some((blockId) => !blockIds.has(blockId)))
		return readOnly("snapshot_invalid", "unknown_block_owner", "Snapshot ownership references an unknown block")

	const interactionIds = new Set<string>()
	for (const interaction of interactions(snapshot)) {
		if (interactionIds.has(interaction.interactionId))
			return readOnly("snapshot_invalid", "duplicate_interaction", "Snapshot contains duplicate interaction identity")
		interactionIds.add(interaction.interactionId)
		if (interaction.status === "prepared") {
			if (!interaction.journalRef)
				return readOnly("snapshot_invalid", "missing_journal_ref", "Prepared interaction has no journal reference")
			const position = parseJournalRef(interaction.journalRef)
			if (!position) return readOnly("snapshot_invalid", "invalid_journal_ref", "Journal reference is not parseable")
			if (isAfter(position, input.journalTail))
				return readOnly(
					"snapshot_invalid",
					"journal_ahead_of_tail",
					"Interaction journal reference is ahead of journal tail",
				)
		}
	}
	if (snapshot.flow.phase === "completed" && !snapshot.flow.completionId)
		return readOnly("snapshot_invalid", "missing_completion_identity", "Completed task has no completion identity")
	if (snapshot.flow.phase === "error" && !snapshot.flow.error)
		return readOnly("snapshot_invalid", "missing_error", "Errored task has no error detail")
	if (snapshot.flow.terminalReason === "consumed" && !snapshot.flow.consumedRef)
		return readOnly("snapshot_invalid", "missing_consumed_identity", "Consumed task has no consumed identity")
	return undefined
}

function classify(snapshot: TaskState): Exclude<HydrateForm, "new"> {
	if (snapshot.flow.terminalReason === "consumed") return "consumed"
	if (snapshot.flow.phase === "completed") return "completed"
	if (snapshot.flow.phase === "error") return "error"
	return "interrupted"
}

function action(actionId: string, payloadPolicy: DialogActionRule["payloadPolicy"]): DialogActionRule {
	return { actionId, payloadPolicy }
}

function recoveryInteraction(state: TaskState, form: Exclude<HydrateForm, "new" | "consumed">): DialogInteraction {
	const interactionId = `${form}:${state.taskId}:${state.revision}`
	const turnId = state.turn.turnId ?? `hydrate:${state.taskId}`
	if (form === "completed") {
		return {
			interactionId,
			turnId,
			kind: "completion",
			status: "planned",
			createdRevision: state.revision,
			presentationRef: `completion:${state.flow.completionId}`,
			actionRules: [action("reply", "draft"), action("start_new_task", "draft")],
		}
	}
	if (form === "error") {
		return {
			interactionId,
			turnId,
			kind: "error_retry",
			status: "planned",
			createdRevision: state.revision,
			presentationRef: `error:${state.revision}`,
			actionRules: [action("retry", "draft"), action("start_new_task", "draft")],
		}
	}
	return {
		interactionId,
		turnId,
		kind: "resume",
		status: "planned",
		createdRevision: state.revision,
		presentationRef: `resume:${state.taskId}:${state.revision}`,
		actionRules: [action("resume", "draft")],
	}
}

function normalizeInteraction(interaction: DialogInteraction, generation: number): DialogInteraction {
	if (interaction.status !== "resolving") return { ...interaction, receiverGeneration: generation }
	return { ...interaction, status: "awaiting", receiverGeneration: generation }
}

function normalizeState(
	snapshot: TaskState,
	form: Exclude<HydrateForm, "new">,
): { readonly state: TaskState; readonly diagnostics: readonly Diagnostic[] } {
	const generation = snapshot.generation + 1
	const revision = snapshot.revision + 1
	const executing = new Set(snapshot.turn.executingBlockIds)
	const blocks = snapshot.turn.blocks.map((block) =>
		executing.has(block.blockId) || block.phase === "executing" ? { ...block, phase: "cancelled" as const } : block,
	)
	const approvalsByBlock = Object.fromEntries(
		Object.entries(snapshot.dialog.approvalsByBlock).map(([blockId, interaction]) => [
			blockId,
			normalizeInteraction(interaction, generation),
		]),
	)
	const normalizeEntries = (entries: TaskState["intake"]["queued"]) =>
		entries.map((entry) =>
			entry.state === "reserved" || entry.state === "included" ? { ...entry, state: "uncertain" as const } : entry,
		)
	let state: TaskState = {
		...snapshot,
		revision,
		generation,
		flow: form === "interrupted" ? { phase: "paused" } : snapshot.flow,
		turn: {
			...snapshot.turn,
			blocks,
			executingBlockIds: [],
			automaticApprovalBlockIds: [],
			manualApprovalBlockId: snapshot.turn.manualApprovalBlockId,
		},
		dialog: {
			primary: snapshot.dialog.primary ? normalizeInteraction(snapshot.dialog.primary, generation) : undefined,
			interrupted: snapshot.dialog.interrupted ? normalizeInteraction(snapshot.dialog.interrupted, generation) : undefined,
			approvalsByBlock,
		},
		intake: {
			queued: normalizeEntries(snapshot.intake.queued),
			background: normalizeEntries(snapshot.intake.background),
			coTask: normalizeEntries(snapshot.intake.coTask),
		},
		halt: { status: "idle", generation },
	}
	if (form === "consumed") {
		state = {
			...state,
			turn: { ...state.turn, manualApprovalBlockId: undefined },
			dialog: { approvalsByBlock: {} },
		}
		return { state, diagnostics: [] }
	}
	if (!state.dialog.primary) {
		state = { ...state, dialog: { ...state.dialog, primary: recoveryInteraction(state, form) } }
	}
	return {
		state,
		diagnostics:
			executing.size > 0 ? [{ code: "inflight_cancelled", message: "In-flight blocks were cancelled during hydrate" }] : [],
	}
}

function initialCommands(state: TaskState): readonly Command[] {
	return [state.dialog.primary, ...Object.values(state.dialog.approvalsByBlock)]
		.filter((interaction): interaction is DialogInteraction => interaction !== undefined)
		.flatMap((interaction, index): readonly Command[] => {
			const base = {
				commandId: `${state.taskId}:${state.revision}:hydrate:${index}`,
				originRevision: state.revision,
				generation: state.generation,
			}
			if (interaction.status === "planned")
				return [{ ...base, type: "dialog.prepare", interactionId: interaction.interactionId, kind: interaction.kind }]
			if (interaction.status === "prepared" && interaction.journalRef)
				return [
					{
						...base,
						type: "dialog.reveal",
						interactionId: interaction.interactionId,
						journalRef: interaction.journalRef,
					},
				]
			return []
		})
}

export function hydrate(input: HydrateInput): HydrateResult {
	if (input.openReason === "new") {
		return { kind: "ready", form: "new", state: createInitialTaskState(input.taskId), initialCommands: [], diagnostics: [] }
	}
	if (!input.snapshot) return readOnly("snapshot_missing", "snapshot_missing", "No snapshot was available")
	const invalid = validateSnapshot(input, input.snapshot)
	if (invalid) return invalid
	const form = classify(input.snapshot)
	const normalized = normalizeState(input.snapshot, form)
	return {
		kind: "ready",
		form,
		state: normalized.state,
		initialCommands: form === "consumed" ? [] : initialCommands(normalized.state),
		diagnostics: normalized.diagnostics,
	}
}
