import type { Command, JournalWatermark, TaskState } from "../kernel"

export type { JournalWatermark } from "../kernel"

export type JournalEntryKind = "message" | "tombstone" | "truncate_boundary" | "supersede_range" | "checkpoint_marker" | "rebase"
export type JournalSource = "provider" | "dialog" | "intake" | "system"

export interface JournalCausation {
	readonly commandId?: string
	readonly originRevision?: number
	readonly generation?: number
	readonly turnId?: string
	readonly interactionId?: string
}

export interface JournalAppendInput {
	readonly operationId: string
	readonly payloadRef: string
	readonly source: JournalSource
	readonly causation?: JournalCausation
}

export interface JournalAppendResult {
	readonly watermark: JournalWatermark
	readonly disposition: "appended" | "existing"
}

export interface JournalEntry {
	readonly version: 1
	readonly watermark: JournalWatermark
	readonly operationId: string
	readonly kind: JournalEntryKind
	readonly payloadRef?: string
	readonly source?: JournalSource
	readonly causation?: JournalCausation
	readonly transientId?: string
	readonly target?: JournalWatermark
	readonly range?: { readonly from: JournalWatermark; readonly to: JournalWatermark }
	readonly previousTail?: JournalWatermark
}

export interface JournalProjection {
	readonly through: JournalWatermark
	readonly visibleMessages: readonly JournalEntry[]
	readonly checkpointMarkers: readonly JournalEntry[]
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
	append(input: JournalAppendInput): Promise<JournalAppendResult>
	read(after?: JournalWatermark, through?: JournalWatermark): Promise<readonly JournalEntry[]>
	findByOperation(operationId: string): Promise<JournalEntry | undefined>
	project(through?: JournalWatermark): Promise<JournalProjection>
	appendTransient(transientId: string, payloadRef: string): void
	finalizeTransient(input: JournalAppendInput & { readonly transientId: string }): Promise<JournalAppendResult>
	rebase(input: { readonly operationId: string; readonly reasonRef: string }): Promise<JournalAppendResult>
	tombstone(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult>
	truncateBoundary(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult>
	supersedeRange(input: {
		readonly operationId: string
		readonly from: JournalWatermark
		readonly to: JournalWatermark
	}): Promise<JournalAppendResult>
	checkpointMarker(input: { readonly operationId: string; readonly checkpointRef: string }): Promise<JournalAppendResult>
	watermark(): JournalWatermark
}

export interface CommandPublicationStore {
	has(effectKey: string): Promise<boolean>
	mark(command: Command, effectKey?: string): Promise<void>
}
