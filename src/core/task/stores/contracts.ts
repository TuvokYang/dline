import type { Command, JournalWatermark, TaskState } from "../kernel"

export type { JournalWatermark } from "../kernel"

export type JournalEntryKind = "message" | "tombstone" | "truncate_boundary" | "supersede_range" | "checkpoint_marker" | "rewind"
export type JournalSource = "provider" | "tool" | "dialog" | "intake" | "system"

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
    /** Tracks a live stream in memory; partial content is never a durable payload. */
    appendTransient(transientId: string): void
    /** Drops a stream that ended without a durable final or interrupted payload. */
    discardTransient(transientId: string): void
    finalizeTransient(input: JournalAppendInput & { readonly transientId: string }): Promise<JournalAppendResult>
    tombstone(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult>
    truncateBoundary(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult>
    /**
     * Hide `[from, to]`; with `replacementRef`, the same record also shows that
     * payload where the span began. One record keeps a replacement atomic: a
     * crash leaves either the original span or its replacement, never neither.
     */
    supersedeRange(input: {
        readonly operationId: string
        readonly from: JournalWatermark
        readonly to: JournalWatermark
        readonly replacementRef?: string
    }): Promise<JournalAppendResult>
    checkpointMarker(input: { readonly operationId: string; readonly checkpointRef: string }): Promise<JournalAppendResult>
    /**
     * Return the projection to what it was right after `target`.
     *
     * Unlike a truncation, a rewind also drops every marker recorded after the
     * target, so a summary that replaced part of the conversation disappears
     * with it. One record keeps the rewind atomic; the entries it undoes stay on
     * disk, so the journal remains append-only.
     */
    rewind(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult>
    watermark(): JournalWatermark
}

export interface CommandPublicationStore {
    has(effectKey: string): Promise<boolean>
    mark(command: Command, effectKey?: string): Promise<void>
}

export type BackgroundDeliveryProducerKind = "command" | "subagent" | "subagent_batch"
export type BackgroundDeliveryState = "pending" | "acknowledged"

/** Producer-owned result retained durably until canonical intake accepts it. */
export interface BackgroundDeliveryRecord {
    readonly entryId: string
    readonly producerKind: BackgroundDeliveryProducerKind
    readonly producerId: string
    readonly attempt: number
    readonly text: string
    readonly state: BackgroundDeliveryState
}

export interface BackgroundDeliveryLedger {
    stage(delivery: Omit<BackgroundDeliveryRecord, "state">): Promise<BackgroundDeliveryRecord>
    listPending(): Promise<readonly BackgroundDeliveryRecord[]>
    acknowledge(entryId: string): Promise<void>
}

/** Content-addressed bytes that journal entries and kernel state refer to by reference. */
export interface TaskPayloadStore {
    /** Stores `payload` and returns its reference; storing equal bytes again returns the same reference. */
    put(payload: Uint8Array): Promise<string>
    read(payloadRef: string): Promise<Uint8Array>
}
