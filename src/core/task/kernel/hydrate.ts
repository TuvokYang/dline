import { withoutAbandonedReview } from "./machines/dialog"
import { expireAbandonedCompaction } from "./machines/flow"
import { planRecoveryDialog, restorableApprovals } from "./recovery"
import type {
	BlockPhase,
	Command,
	Diagnostic,
	DialogActionRule,
	DialogInteraction,
	HydrateForm,
	HydrateInput,
	HydrateResult,
	JournalWatermark,
	TaskState,
} from "./types"
import { createInitialTaskState } from "./types"

function invalid(code: string, message: string): readonly Diagnostic[] {
	return [{ code, message }]
}

function parseJournalRef(ref: string): JournalWatermark | undefined {
	const match = ref.match(/^journal:(\d+)$/)
	if (!match) return undefined
	return { seq: Number(match[1]) }
}

function isAfter(position: JournalWatermark, tail: JournalWatermark): boolean {
	return position.seq > tail.seq
}

function interactions(state: TaskState): readonly DialogInteraction[] {
	return [state.dialog.primary, state.dialog.interrupted, ...Object.values(state.dialog.approvalsByBlock)].filter(
		(interaction): interaction is DialogInteraction => interaction !== undefined,
	)
}

/** A block in one of these phases never reads its invocation again. */
const SETTLED_BLOCK_PHASES: ReadonlySet<BlockPhase> = new Set(["completed", "failed", "rejected", "skipped", "cancelled"])

/**
 * Whether `state` has the structure every later check dereferences.
 *
 * A snapshot is decoded from disk, so a truncated or hand-edited file can hold
 * any shape. Checking it first keeps a malformed snapshot a recoverable
 * diagnostic instead of an exception that stops the task from opening.
 */
function isShaped(state: TaskState): boolean {
	const candidate = state as Partial<TaskState> | null
	return (
		typeof candidate === "object" &&
		candidate !== null &&
		typeof candidate.flow?.phase === "string" &&
		Array.isArray(candidate.turn?.blocks) &&
		Array.isArray(candidate.turn.executingBlockIds) &&
		Array.isArray(candidate.turn.automaticApprovalBlockIds) &&
		Array.isArray(candidate.turn.manualApprovalBlockIds) &&
		typeof candidate.dialog?.approvalsByBlock === "object" &&
		candidate.dialog.approvalsByBlock !== null &&
		typeof candidate.halt === "object" &&
		candidate.halt !== null &&
		// Absent intake is a legacy snapshot and is normalized; a present one must be lists.
		(candidate.intake === undefined ||
			[candidate.intake.queued, candidate.intake.background, candidate.intake.coTask].every(
				(entries) => entries === undefined || Array.isArray(entries),
			))
	)
}

/**
 * Payloads a restored snapshot will read once its work continues.
 *
 * Unsettled blocks re-read their invocation, intake not yet consumed is
 * composed again, and an accepted dialog response carries its draft or
 * selection. The shell checks these against the payload store before hydrate,
 * so a snapshot whose inputs are gone is rebuilt instead of failing later in
 * the middle of a round.
 */
export function requiredPayloadRefs(state: TaskState): readonly string[] {
	if (!isShaped(state)) return []
	const refs = new Set<string>()
	const intake = state.intake
	for (const entry of [...(intake?.queued ?? []), ...(intake?.background ?? []), ...(intake?.coTask ?? [])]) {
		if (entry.state !== "consumed") refs.add(entry.payloadRef)
	}
	for (const block of state.turn.blocks) {
		if (!SETTLED_BLOCK_PHASES.has(block.phase)) refs.add(block.invocationRef)
	}
	for (const interaction of interactions(state)) {
		const response = interaction.acceptedResponse
		if (response?.draftRef) refs.add(response.draftRef)
		if (response?.selectionRef) refs.add(response.selectionRef)
	}
	return [...refs]
}

/** Why `snapshot` cannot be continued, or undefined when it can. */
function validateSnapshot(input: HydrateInput, snapshot: TaskState): readonly Diagnostic[] | undefined {
	if (!isShaped(snapshot)) return invalid("malformed_snapshot", "Snapshot does not have the structure of a task state")
	if (snapshot.taskId !== input.taskId) return invalid("task_identity_mismatch", "Snapshot belongs to another task")
	if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0)
		return invalid("invalid_revision", "Snapshot revision is invalid")
	if (!Number.isInteger(snapshot.generation) || snapshot.generation < 0 || snapshot.halt.generation !== snapshot.generation)
		return invalid("invalid_generation", "Snapshot generation is inconsistent")
	if (snapshot.journalWatermark && isAfter(snapshot.journalWatermark, input.journalTail))
		return invalid("journal_ahead_of_tail", "Snapshot journal watermark is ahead of journal tail")

	const blockIds = new Set<string>()
	const indexes = new Set<number>()
	for (const block of snapshot.turn.blocks) {
		if (blockIds.has(block.blockId) || indexes.has(block.index))
			return invalid("duplicate_block_identity", "Snapshot contains duplicate block identity")
		blockIds.add(block.blockId)
		indexes.add(block.index)
	}
	const ownedBlockIds = [
		...snapshot.turn.executingBlockIds,
		...snapshot.turn.automaticApprovalBlockIds,
		...snapshot.turn.manualApprovalBlockIds,
	]
	if (ownedBlockIds.some((blockId) => !blockIds.has(blockId)))
		return invalid("unknown_block_owner", "Snapshot ownership references an unknown block")

	const interactionIds = new Set<string>()
	for (const interaction of interactions(snapshot)) {
		if (interactionIds.has(interaction.interactionId))
			return invalid("duplicate_interaction", "Snapshot contains duplicate interaction identity")
		interactionIds.add(interaction.interactionId)
		if (interaction.status === "prepared") {
			if (!interaction.journalRef) return invalid("missing_journal_ref", "Prepared interaction has no journal reference")
			const position = parseJournalRef(interaction.journalRef)
			if (!position) return invalid("invalid_journal_ref", "Journal reference is not parseable")
			if (isAfter(position, input.journalTail))
				return invalid("journal_ahead_of_tail", "Interaction journal reference is ahead of journal tail")
		}
	}
	if (snapshot.flow.phase === "completed" && !snapshot.flow.completionId)
		return invalid("missing_completion_identity", "Completed task has no completion identity")
	if (snapshot.flow.phase === "error" && !snapshot.flow.error)
		return invalid("missing_error", "Errored task has no error detail")
	if (snapshot.flow.terminalReason === "consumed" && !snapshot.flow.consumedRef)
		return invalid("missing_consumed_identity", "Consumed task has no consumed identity")
	const unavailable = input.unavailablePayloads
	const missing = unavailable ? requiredPayloadRefs(snapshot).filter((ref) => unavailable.has(ref)) : []
	if (missing.length > 0)
		return invalid("payload_missing", `Snapshot requires ${missing.length} payload(s) the payload store cannot provide`)
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
			prepareKey: `dialog.prepare:${interactionId}`,
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
			prepareKey: `dialog.prepare:${interactionId}`,
		}
	}
	// Shared with the offer a live cancellation raises, so both recovery paths
	// keep one definition of what resuming means.
	const plan = planRecoveryDialog({ taskId: state.taskId, revision: state.revision, reason: "interrupted", turnId })
	return {
		...plan,
		status: "planned",
		createdRevision: state.revision,
		prepareKey: `dialog.prepare:${plan.interactionId}`,
	}
}

function normalizeInteraction(interaction: DialogInteraction, generation: number): DialogInteraction {
	const normalized = {
		...interaction,
		receiverGeneration: generation,
		prepareKey: interaction.prepareKey ?? `dialog.prepare:${interaction.interactionId}`,
		revealKey: interaction.journalRef ? `dialog.reveal:${interaction.interactionId}:${generation}` : undefined,
		prepare: undefined,
		reveal: undefined,
	}
	if (interaction.status !== "resolving") return normalized
	return { ...normalized, status: "awaiting" }
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
	const normalizeEntries = (entries: TaskState["intake"]["queued"] = []) =>
		entries.map((entry) => {
			if (entry.state !== "reserved" && entry.state !== "included" && entry.state !== "uncertain") return entry
			if (!entry.journalWatermark) return { ...entry, state: "uncertain" as const }
			return {
				...entry,
				state: isAfter(entry.journalWatermark, snapshot.journalWatermark ?? { seq: 0 })
					? ("released" as const)
					: ("consumed" as const),
			}
		})
	const legacyIntake = snapshot.intake ?? { queued: [], background: [], coTask: [] }
	// A review whose run died with the process has nobody left to answer it.
	const dialog = withoutAbandonedReview(snapshot.dialog, snapshot.flow.compaction)
	let state: TaskState = {
		...snapshot,
		revision,
		generation,
		// The process that ran any compaction is gone, so its slot is released
		// whatever form the task restores into.
		flow:
			form === "interrupted"
				? { phase: "paused" }
				: { ...snapshot.flow, compaction: expireAbandonedCompaction(snapshot.flow.compaction, "compaction_interrupted") },
		turn: {
			...snapshot.turn,
			blocks,
			executingBlockIds: [],
			automaticApprovalBlockIds: [],
			manualApprovalBlockIds: snapshot.turn.manualApprovalBlockIds,
		},
		dialog: {
			primary: dialog.primary ? normalizeInteraction(dialog.primary, generation) : undefined,
			interrupted: dialog.interrupted ? normalizeInteraction(dialog.interrupted, generation) : undefined,
			approvalsByBlock,
		},
		intake: {
			queued: normalizeEntries(legacyIntake.queued),
			background: normalizeEntries(legacyIntake.background),
			coTask: normalizeEntries(legacyIntake.coTask),
		},
		halt: { status: "idle", generation },
		journalWatermark: snapshot.journalWatermark ?? { seq: 0 },
	}
	if (form === "consumed") {
		state = {
			...state,
			turn: { ...state.turn, manualApprovalBlockIds: [] },
			dialog: { approvalsByBlock: {} },
		}
		return { state, diagnostics: [] }
	}
	const approvals = restorableApprovals(state)
	const hasRestorableApproval = Object.keys(approvals).length > 0
	if (hasRestorableApproval) {
		state = {
			...state,
			flow: form === "interrupted" ? { phase: "waiting" } : state.flow,
			dialog: { ...state.dialog, primary: undefined, approvalsByBlock: approvals },
		}
	} else if (!state.dialog.primary) {
		state = { ...state, dialog: { ...state.dialog, primary: recoveryInteraction(state, form) } }
	}
	return {
		state,
		diagnostics:
			executing.size > 0 ? [{ code: "inflight_cancelled", message: "In-flight blocks were cancelled during hydrate" }] : [],
	}
}

function dialogCommandInput(interaction: DialogInteraction) {
	return {
		interactionId: interaction.interactionId,
		turnId: interaction.turnId,
		kind: interaction.kind,
		presentationRef: interaction.presentationRef,
		actionRules: interaction.actionRules,
		blockId: interaction.blockId,
		prepareKey: interaction.prepareKey ?? `dialog.prepare:${interaction.interactionId}`,
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
			if (interaction.status === "planned") return [{ ...base, type: "dialog.prepare", ...dialogCommandInput(interaction) }]
			if (interaction.status === "prepared" && interaction.journalRef && interaction.receiverGeneration !== undefined)
				return [
					{
						...base,
						type: "dialog.reveal",
						...dialogCommandInput(interaction),
						journalRef: interaction.journalRef,
						receiverGeneration: interaction.receiverGeneration,
						revealKey:
							interaction.revealKey ??
							`dialog.reveal:${interaction.interactionId}:${interaction.receiverGeneration}`,
					},
				]
			return []
		})
}

function installDialogCommandOwners(state: TaskState, commands: readonly Command[]): TaskState {
	const ownership = new Map(
		commands
			.filter(
				(command): command is Extract<Command, { type: "dialog.prepare" | "dialog.reveal" }> =>
					command.type === "dialog.prepare" || command.type === "dialog.reveal",
			)
			.map((command) => [command.interactionId, command] as const),
	)
	const own = (interaction: DialogInteraction | undefined): DialogInteraction | undefined => {
		if (!interaction) return undefined
		const command = ownership.get(interaction.interactionId)
		if (!command) return interaction
		return {
			...interaction,
			[command.type === "dialog.prepare" ? "prepare" : "reveal"]: {
				commandId: command.commandId,
				originRevision: command.originRevision,
				status: "running",
			},
		}
	}
	return {
		...state,
		dialog: {
			primary: own(state.dialog.primary),
			interrupted: own(state.dialog.interrupted),
			approvalsByBlock: Object.fromEntries(
				Object.entries(state.dialog.approvalsByBlock).map(([blockId, interaction]) => [
					blockId,
					own(interaction) ?? interaction,
				]),
			),
		},
	}
}

/**
 * Rebuild a task from its journal alone, as interrupted.
 *
 * Used when the snapshot is missing or cannot be continued. The journal is the
 * durable conversation, so the task keeps everything the user and the model
 * said; only in-flight state is lost, and `cause` records why. Refusing the
 * task instead left it permanently unusable: the surface offered Resume and
 * every attempt to act on it failed.
 */
function hydrateWithoutSnapshot(input: HydrateInput, cause: readonly Diagnostic[]): HydrateResult {
	const state: TaskState = {
		...createInitialTaskState(input.taskId),
		...continuedCounters(input),
		journalWatermark: input.journalTail,
	}
	const normalized = normalizeState(state, "interrupted")
	const commands = initialCommands(normalized.state)
	return {
		kind: "ready",
		form: "interrupted",
		rebuilt: true,
		state: installDialogCommandOwners(normalized.state, commands),
		initialCommands: commands,
		diagnostics: [...normalized.diagnostics, ...cause],
	}
}

function isCount(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0
}

/**
 * Revision and generation a rebuilt task continues from.
 *
 * Command and interaction identities are derived from them, and a published
 * command is remembered by that identity and never dispatched again. Starting
 * every rebuild from zero could reuse an identity an earlier rebuild already
 * published, leaving the recovery dialog planned but never prepared.
 */
function continuedCounters(input: HydrateInput): { readonly revision: number; readonly generation: number } {
	const snapshot = input.snapshot as Partial<TaskState> | undefined
	if (typeof snapshot !== "object" || snapshot === null || snapshot.taskId !== input.taskId)
		return { revision: 0, generation: 0 }
	return {
		revision: isCount(snapshot.revision) ? snapshot.revision : 0,
		generation: isCount(snapshot.generation) ? snapshot.generation : 0,
	}
}

/**
 * The snapshot a chat restore resumes from.
 *
 * A restore rewinds the conversation behind the snapshot, so every fact the
 * snapshot holds about the discarded tail is stale: its turn's blocks and
 * approvals refer to messages that are gone, and its dialog - a completion,
 * an error retry, a question - answers a conversation the user just undid.
 * The task is therefore rebuilt as interrupted, which offers to resume from
 * the restored point instead of reopening whatever the tail last ended in.
 *
 * A consumed task is left alone: it was handed to a successor, and restoring
 * its chat does not take that back.
 */
function rewoundSnapshot(snapshot: TaskState): TaskState {
	if (classify(snapshot) === "consumed") return snapshot
	return {
		...snapshot,
		flow: { phase: "paused" },
		turn: {
			...snapshot.turn,
			blocks: [],
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: [],
		},
		dialog: { approvalsByBlock: {} },
	}
}

/**
 * Open a task into a state its runtime can continue from.
 *
 * Opening an existing task always succeeds. A missing or unusable snapshot
 * costs the in-flight state, never the task: it is rebuilt as interrupted from
 * the journal, marked `rebuilt`, and the reason travels as a diagnostic.
 */
export function hydrate(input: HydrateInput): HydrateResult {
	if (input.openReason === "new") {
		return {
			kind: "ready",
			form: "new",
			rebuilt: false,
			state: createInitialTaskState(input.taskId),
			initialCommands: [],
			diagnostics: [],
		}
	}
	if (!input.snapshot) {
		return hydrateWithoutSnapshot(input, invalid("snapshot_missing", "Recovered from the journal without a runtime snapshot"))
	}
	const unusable = validateSnapshot(input, input.snapshot)
	if (unusable) return hydrateWithoutSnapshot(input, unusable)
	const snapshot = input.openReason === "checkpoint_restore" ? rewoundSnapshot(input.snapshot) : input.snapshot
	const form = classify(snapshot)
	const normalized = normalizeState(snapshot, form)
	const commands = form === "consumed" ? [] : initialCommands(normalized.state)
	return {
		kind: "ready",
		form,
		rebuilt: false,
		state: installDialogCommandOwners(normalized.state, commands),
		initialCommands: commands,
		diagnostics: normalized.diagnostics,
	}
}
