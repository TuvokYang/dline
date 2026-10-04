import type { Command, TaskState } from "../kernel"
import type {
	BackgroundDeliveryLedger,
	BackgroundDeliveryRecord,
	CommandPublicationStore,
	ConversationJournal,
	DurableTaskSnapshot,
	JournalAppendInput,
	JournalAppendResult,
	JournalEntry,
	JournalEntryKind,
	JournalWatermark,
	StateVault,
	TaskPayloadStore,
	TaskViewPort,
} from "./contracts"
import { journalOperationFingerprint } from "./JournalOperationIdentity"
import { compareJournalWatermarks, rebuildJournalProjection } from "./JournalProjection"
import { assertTaskPayloadRef, taskPayloadRef } from "./payload/TaskPayloadRef"

export class InMemoryStateVault implements StateVault {
	private readonly snapshots = new Map<string, DurableTaskSnapshot>()

	async load(taskId: string): Promise<DurableTaskSnapshot | undefined> {
		return this.snapshots.get(taskId)
	}

	async save(snapshot: DurableTaskSnapshot): Promise<void> {
		this.snapshots.set(snapshot.state.taskId, snapshot)
	}
}

export class InMemoryTaskViewPort implements TaskViewPort {
	readonly committed: TaskState[] = []
	readonly transient: Array<{ taskId: string; projection: Readonly<Record<string, unknown>> }> = []

	async notifyCommitted(state: TaskState): Promise<void> {
		this.committed.push(state)
	}

	notifyTransient(taskId: string, projection: Readonly<Record<string, unknown>>): void {
		this.transient.push({ taskId, projection })
	}
}

export class InMemoryCommandPublicationStore implements CommandPublicationStore {
	private readonly published = new Set<string>()

	async has(effectKey: string): Promise<boolean> {
		return this.published.has(effectKey)
	}

	async mark(command: Command, effectKey = command.commandId): Promise<void> {
		this.published.add(effectKey)
	}
}

export class InMemoryBackgroundDeliveryLedger implements BackgroundDeliveryLedger {
	private readonly records = new Map<string, BackgroundDeliveryRecord>()

	async stage(delivery: Omit<BackgroundDeliveryRecord, "state">): Promise<BackgroundDeliveryRecord> {
		const existing = this.records.get(delivery.entryId)
		if (existing) {
			if (
				existing.producerKind !== delivery.producerKind ||
				existing.producerId !== delivery.producerId ||
				existing.attempt !== delivery.attempt ||
				existing.text !== delivery.text
			) {
				throw new Error(`BackgroundDeliveryConflict:${delivery.entryId}`)
			}
			return existing
		}
		const record: BackgroundDeliveryRecord = { ...delivery, state: "pending" }
		this.records.set(record.entryId, record)
		return record
	}

	async listPending(): Promise<readonly BackgroundDeliveryRecord[]> {
		return [...this.records.values()].filter((record) => record.state === "pending")
	}

	async acknowledge(entryId: string): Promise<void> {
		const existing = this.records.get(entryId)
		if (existing) this.records.set(entryId, { ...existing, state: "acknowledged" })
	}
}

/** Content-addressed payloads kept in memory, with the same references as the durable store. */
export class InMemoryTaskPayloadStore implements TaskPayloadStore {
	private readonly payloads = new Map<string, Uint8Array>()

	async put(payload: Uint8Array): Promise<string> {
		const payloadRef = taskPayloadRef(payload)
		this.payloads.set(payloadRef, new Uint8Array(payload))
		return payloadRef
	}

	async read(payloadRef: string): Promise<Uint8Array> {
		assertTaskPayloadRef(payloadRef)
		const payload = this.payloads.get(payloadRef)
		if (!payload) throw new Error(`TaskPayloadNotFound: ${payloadRef}`)
		return new Uint8Array(payload)
	}
}

export class InMemoryConversationJournal implements ConversationJournal {
	private current: JournalWatermark = { seq: 0 }
	private readonly entries: JournalEntry[] = []
	private readonly operations = new Map<string, { readonly fingerprint: string; readonly entry: JournalEntry }>()
	private readonly transient = new Set<string>()

	watermark(): JournalWatermark {
		return this.current
	}

	async append(input: JournalAppendInput): Promise<JournalAppendResult> {
		return this.record("message", input.operationId, {
			payloadRef: input.payloadRef,
			source: input.source,
			causation: input.causation,
		})
	}

	async read(after?: JournalWatermark, through?: JournalWatermark): Promise<readonly JournalEntry[]> {
		return this.entries.filter(
			(entry) =>
				(!after || compareJournalWatermarks(entry.watermark, after) > 0) &&
				(!through || compareJournalWatermarks(entry.watermark, through) <= 0),
		)
	}

	async findByOperation(operationId: string): Promise<JournalEntry | undefined> {
		return this.operations.get(operationId)?.entry
	}

	async project(through = this.current) {
		return rebuildJournalProjection(this.entries, through)
	}

	appendTransient(transientId: string): void {
		this.transient.add(transientId)
	}

	discardTransient(transientId: string): void {
		this.transient.delete(transientId)
	}

	async finalizeTransient(input: JournalAppendInput & { readonly transientId: string }): Promise<JournalAppendResult> {
		const content = {
			payloadRef: input.payloadRef,
			source: input.source,
			causation: input.causation,
			transientId: input.transientId,
		}
		const existing = this.idempotent(input.operationId, "message", content)
		if (existing) return existing
		if (!this.transient.has(input.transientId)) throw new Error(`Unknown transient journal entry: ${input.transientId}`)
		const result = this.record("message", input.operationId, content)
		this.transient.delete(input.transientId)
		return result
	}

	async rewind(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult> {
		return this.record("rewind", input.operationId, { target: input.target })
	}

	async tombstone(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult> {
		return this.record("tombstone", input.operationId, { target: input.target })
	}

	async truncateBoundary(input: {
		readonly operationId: string
		readonly target: JournalWatermark
	}): Promise<JournalAppendResult> {
		return this.record("truncate_boundary", input.operationId, { target: input.target })
	}

	async supersedeRange(input: {
		readonly operationId: string
		readonly from: JournalWatermark
		readonly to: JournalWatermark
		readonly replacementRef?: string
	}): Promise<JournalAppendResult> {
		if (compareJournalWatermarks(input.from, input.to) > 0) throw new Error("Supersede range must be ordered")
		return this.record("supersede_range", input.operationId, {
			range: { from: input.from, to: input.to },
			...(input.replacementRef === undefined ? {} : { payloadRef: input.replacementRef }),
		})
	}

	async checkpointMarker(input: {
		readonly operationId: string
		readonly checkpointRef: string
	}): Promise<JournalAppendResult> {
		return this.record("checkpoint_marker", input.operationId, { payloadRef: input.checkpointRef })
	}

	private idempotent(
		operationId: string,
		kind: JournalEntryKind,
		entry: Omit<JournalEntry, "version" | "operationId" | "kind" | "watermark">,
	): JournalAppendResult | undefined {
		const fingerprint = journalOperationFingerprint(kind, entry)
		const existing = this.operations.get(operationId)
		if (!existing) return undefined
		if (existing.fingerprint !== fingerprint) throw new Error(`Journal operation conflict: ${operationId}`)
		return { watermark: existing.entry.watermark, disposition: "existing" }
	}

	private record(
		kind: JournalEntryKind,
		operationId: string,
		entry: Omit<JournalEntry, "version" | "operationId" | "kind" | "watermark">,
	): JournalAppendResult {
		const existing = this.idempotent(operationId, kind, entry)
		if (existing) return existing
		this.current = { seq: this.current.seq + 1 }
		const recorded: JournalEntry = { ...entry, version: 1, operationId, kind, watermark: this.current }
		this.entries.push(recorded)
		this.operations.set(operationId, { fingerprint: journalOperationFingerprint(kind, entry), entry: recorded })
		return { watermark: this.current, disposition: "appended" }
	}
}
