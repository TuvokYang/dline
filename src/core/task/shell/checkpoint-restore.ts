import { hydrate } from "../kernel/hydrate"
import type { Diagnostic } from "../kernel/types"
import type { DurableTaskSnapshot, JournalWatermark } from "../stores/contracts"

export type CheckpointRestoreMode = "combined" | "chat_only" | "workspace_only"

export interface ResolvedCheckpoint {
	readonly snapshot: DurableTaskSnapshot
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
	const checkpoint = await ports.resolve(input.checkpointRef)
	if (input.mode === "workspace_only") {
		if (!checkpoint.workspaceRef) return rejected("workspace_checkpoint_missing", "Checkpoint has no workspace reference")
		const workspace = await ports.restoreWorkspace(checkpoint.workspaceRef)
		return workspace.ok ? { kind: "restored", diagnostics: [] } : { kind: "rejected", diagnostics: [workspace.diagnostic] }
	}
	const hydrated = hydrate({
		taskId: input.taskId,
		snapshot: checkpoint.snapshot.state,
		journalTail: checkpoint.boundary,
		openReason: "checkpoint_restore",
	})
	// Restoring must not replace the task's state with one rebuilt from nothing:
	// a checkpoint whose snapshot cannot be continued is refused before anything
	// is touched, and the task keeps what it had.
	if (hydrated.rebuilt) return { kind: "rejected", diagnostics: hydrated.diagnostics }
	if (input.mode === "combined" && !checkpoint.workspaceRef) {
		return rejected("workspace_checkpoint_missing", "Checkpoint has no workspace reference")
	}

	await ports.stopAndFence()
	const diagnostics: Diagnostic[] = [...hydrated.diagnostics]
	if (input.mode === "combined") {
		const workspace = await ports.restoreWorkspace(checkpoint.workspaceRef!)
		if (!workspace.ok) diagnostics.push(workspace.diagnostic)
	}

	await ports.applyConversationBoundary(checkpoint.boundary)
	const snapshot: DurableTaskSnapshot = {
		state: hydrated.state,
		// The stored outbox belongs to the state at capture time. Rewind deliberately
		// removes that turn and its blocks, so replaying those commands (for example
		// its tool.run) can only target discarded work and starve the restored Resume.
		// The restored state's planned dialog is enough: reopen hydrate derives its
		// command exactly once, whereas persisting it here duplicates dialog.prepare.
		outbox: [],
	}
	await ports.save(snapshot)
	return { kind: "restored", snapshot, diagnostics }
}
