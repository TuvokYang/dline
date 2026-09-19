import type { Command, TaskState } from "../kernel"

export interface JournalWatermark {
	readonly epoch: number
	readonly seq: number
}

export type JournalEntryKind = "message" | "tombstone" | "truncate_boundary" | "supersede_range" | "checkpoint_marker" | "rebase"

export interface JournalEntry {
	readonly watermark: JournalWatermark
	readonly kind: JournalEntryKind
	readonly payloadRef?: string
	readonly transientId?: string
	readonly target?: JournalWatermark
	readonly range?: { readonly from: JournalWatermark; readonly to: JournalWatermark }
}

export interface DurableTaskSnapshot {
	readonly state: TaskState
	readonly outbox: readonly Command[]
}

export interface StateVault {
	load(taskId: string): Promise<DurableTaskSnapshot | undefined>
	save(snapshot: DurableTaskSnapshot): Promise<void>
}

export interface TaskViewPort {
	notifyCommitted(state: TaskState): Promise<void>
	notifyTransient(taskId: string, projection: Readonly<Record<string, unknown>>): void
}

export interface ConversationJournal {
	append(payloadRef: string): Promise<JournalWatermark>
	read(after?: JournalWatermark): Promise<readonly JournalEntry[]>
	appendTransient(transientId: string, payloadRef: string): void
	finalizeTransient(transientId: string, payloadRef?: string): Promise<JournalWatermark>
	rebase(reasonRef: string): Promise<JournalWatermark>
	tombstone(target: JournalWatermark): Promise<JournalWatermark>
	truncateBoundary(target: JournalWatermark): Promise<JournalWatermark>
	supersedeRange(from: JournalWatermark, to: JournalWatermark): Promise<JournalWatermark>
	checkpointMarker(checkpointRef: string): Promise<JournalWatermark>
	watermark(): JournalWatermark
}

export interface CommandPublicationStore {
	has(commandId: string): Promise<boolean>
	mark(command: Command): Promise<void>
}
