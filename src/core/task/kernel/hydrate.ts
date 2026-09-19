import type { Command, HydrateInput, HydrateResult, TaskState } from "./types"
import { createInitialTaskState } from "./types"

function revealCommands(state: TaskState): readonly Command[] {
	const interactions = [state.dialog.primary, ...Object.values(state.dialog.approvalsByBlock)].filter(
		(interaction) => interaction?.status === "prepared" && interaction.journalRef,
	)
	return interactions.map((interaction, index) => ({
		commandId: `${state.taskId}:${state.revision}:hydrate:${index}`,
		originRevision: state.revision,
		generation: state.generation,
		type: "dialog.reveal" as const,
		interactionId: interaction!.interactionId,
		journalRef: interaction!.journalRef!,
	}))
}

export function hydrate(input: HydrateInput): HydrateResult {
	if (input.openReason === "new") {
		return { kind: "ready", state: createInitialTaskState(input.taskId), initialCommands: [], diagnostics: [] }
	}
	if (!input.snapshot)
		return {
			kind: "read_only",
			reason: "snapshot_missing",
			diagnostics: [{ code: "snapshot_missing", message: "No snapshot was available" }],
		}
	if (input.snapshot.taskId !== input.taskId)
		return {
			kind: "read_only",
			reason: "task_identity_mismatch",
			diagnostics: [{ code: "task_identity_mismatch", message: "Snapshot belongs to another task" }],
		}
	if (!Number.isInteger(input.snapshot.revision) || input.snapshot.revision < 0)
		return {
			kind: "read_only",
			reason: "snapshot_invalid",
			diagnostics: [{ code: "snapshot_invalid", message: "Snapshot revision is invalid" }],
		}

	const state: TaskState = {
		...input.snapshot,
		turn: { ...input.snapshot.turn, executingBlockIds: [] },
		halt: { status: "idle", generation: input.snapshot.halt.generation },
	}
	return { kind: "ready", state, initialCommands: revealCommands(state), diagnostics: [] }
}
