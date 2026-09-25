import { hydrate } from "../kernel/hydrate"
import type { Diagnostic, TaskState } from "../kernel/types"
import type { DurableTaskSnapshot, JournalWatermark } from "../stores/contracts"

export type CheckpointRestoreMode = "combined" | "chat_only" | "workspace_only"

export interface ResolvedCheckpoint {
	readonly snapshot: TaskState
	readonly boundary: JournalWatermark
	readonly workspaceRef?: string
}

export type WorkspaceRestoreResult = { readonly ok: true } | { readonly ok: false; readonly diagnostic: Diagnostic }

export interface CheckpointRestorePorts {
	stopAndFence(): Promise<void>
	resolve(checkpointRef: string): Promise<ResolvedCheckpoint>
	restoreWorkspace(workspaceRef: string): Promise<WorkspaceRestoreResult>
	applyConversationBoundary(boundary: JournalWatermark): Promise<JournalWatermark>
	save(snapshot: DurableTaskSnapshot): Promise<void>
}

export interface CheckpointRestoreInput {
	readonly taskId: string
	readonly checkpointRef: string
	readonly mode: CheckpointRestoreMode
}

export type CheckpointRestoreResult =
	| {
			readonly kind: "restored"
			readonly snapshot?: DurableTaskSnapshot
			readonly diagnostics: readonly Diagnostic[]
	  }
	| { readonly kind: "rejected"; readonly diagnostics: readonly Diagnostic[] }

function rejected(code: string, message: string): CheckpointRestoreResult {
	return { kind: "rejected", diagnostics: [{ code, message }] }
}

export async function restoreCheckpoint(
	input: CheckpointRestoreInput,
	ports: CheckpointRestorePorts,
): Promise<CheckpointRestoreResult> {
	await ports.stopAndFence()
	const checkpoint = await ports.resolve(input.checkpointRef)
	const hydrated = hydrate({
		taskId: input.taskId,
		snapshot: checkpoint.snapshot,
		journalTail: checkpoint.boundary,
		openReason: "checkpoint_restore",
	})
	// Restoring must not replace the task's state with one rebuilt from nothing:
	// a checkpoint whose snapshot cannot be continued is refused before anything
	// is touched, and the task keeps what it had.
	if (hydrated.rebuilt) return { kind: "rejected", diagnostics: hydrated.diagnostics }

	const diagnostics: Diagnostic[] = [...hydrated.diagnostics]
	if (input.mode !== "chat_only") {
		if (!checkpoint.workspaceRef) return rejected("workspace_checkpoint_missing", "Checkpoint has no workspace reference")
		const workspace = await ports.restoreWorkspace(checkpoint.workspaceRef)
		if (!workspace.ok) {
			if (input.mode === "workspace_only") return { kind: "rejected", diagnostics: [workspace.diagnostic] }
			diagnostics.push(workspace.diagnostic)
		}
	}
	if (input.mode === "workspace_only") return { kind: "restored", diagnostics }

	await ports.applyConversationBoundary(checkpoint.boundary)
	const snapshot: DurableTaskSnapshot = { state: hydrated.state, outbox: hydrated.initialCommands }
	await ports.save(snapshot)
	return { kind: "restored", snapshot, diagnostics }
}
