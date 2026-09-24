import type { Command, TaskState } from "../kernel"
import type {
	CommandPublicationStore,
	ConversationJournal,
	DurableTaskSnapshot,
	JournalAppendInput,
	JournalAppendResult,
	JournalEntry,
	JournalEntryKind,
	JournalWatermark,
	StateVault,
	TaskViewPort,
} from "./contracts"
import { compareJournalWatermarks, rebuildJournalProjection } from "./JournalProjection"

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

export class InMemoryConversationJournal implements ConversationJournal {
	private current: JournalWatermark = { epoch: 0, seq: 0 }
	private readonly entries: JournalEntry[] = []
	private readonly operations = new Map<string, { readonly fingerprint: string; readonly entry: JournalEntry }>()
	private readonly transient = new Map<string, string>()

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

	appendTransient(transientId: string, payloadRef: string): void {
		this.transient.set(transientId, payloadRef)
	}

	async finalizeTransient(input: JournalAppendInput & { readonly transientId: string }): Promise<JournalAppendResult> {
		const resolved = input.payloadRef || this.transient.get(input.transientId)
		if (!resolved) throw new Error(`Unknown transient journal entry: ${input.transientId}`)
		const result = this.record("message", input.operationId, {
			payloadRef: resolved,
			source: input.source,
			causation: input.causation,
			transientId: input.transientId,
		})
		this.transient.delete(input.transientId)
		return result
	}

	async rebase(input: { readonly operationId: string; readonly reasonRef: string }): Promise<JournalAppendResult> {
		const existing = this.idempotent(input.operationId, "rebase", { payloadRef: input.reasonRef, previousTail: this.current })
		if (existing) return existing
		const previousTail = this.current
		this.current = { epoch: this.current.epoch + 1, seq: 0 }
		return this.record("rebase", input.operationId, { payloadRef: input.reasonRef, previousTail })
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
		const fingerprint = JSON.stringify({ kind, entry })
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
		this.current = { epoch: this.current.epoch, seq: this.current.seq + 1 }
		const recorded: JournalEntry = { ...entry, version: 1, operationId, kind, watermark: this.current }
		this.entries.push(recorded)
		this.operations.set(operationId, { fingerprint: JSON.stringify({ kind, entry }), entry: recorded })
		return { watermark: this.current, disposition: "appended" }
	}
}
