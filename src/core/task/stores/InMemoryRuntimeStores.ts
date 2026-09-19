import type { Command, TaskState } from "../kernel"
import type {
	CommandPublicationStore,
	ConversationJournal,
	DurableTaskSnapshot,
	JournalEntry,
	JournalEntryKind,
	JournalWatermark,
	StateVault,
	TaskViewPort,
} from "./contracts"

function compareWatermark(left: JournalWatermark, right: JournalWatermark): number {
	return left.epoch === right.epoch ? left.seq - right.seq : left.epoch - right.epoch
}

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

	async has(commandId: string): Promise<boolean> {
		return this.published.has(commandId)
	}

	async mark(command: Command): Promise<void> {
		this.published.add(command.commandId)
	}
}

export class InMemoryConversationJournal implements ConversationJournal {
	private current: JournalWatermark = { epoch: 0, seq: 0 }
	private readonly entries: JournalEntry[] = []
	private readonly transient = new Map<string, string>()

	watermark(): JournalWatermark {
		return this.current
	}

	async append(payloadRef: string): Promise<JournalWatermark> {
		return this.record("message", { payloadRef })
	}

	async read(after?: JournalWatermark): Promise<readonly JournalEntry[]> {
		return after ? this.entries.filter((entry) => compareWatermark(entry.watermark, after) > 0) : [...this.entries]
	}

	appendTransient(transientId: string, payloadRef: string): void {
		this.transient.set(transientId, payloadRef)
	}

	async finalizeTransient(transientId: string, payloadRef?: string): Promise<JournalWatermark> {
		const resolved = payloadRef ?? this.transient.get(transientId)
		if (!resolved) throw new Error(`Unknown transient journal entry: ${transientId}`)
		this.transient.delete(transientId)
		return this.record("message", { payloadRef: resolved, transientId })
	}

	async rebase(reasonRef: string): Promise<JournalWatermark> {
		this.current = { epoch: this.current.epoch + 1, seq: 0 }
		return this.record("rebase", { payloadRef: reasonRef })
	}

	async tombstone(target: JournalWatermark): Promise<JournalWatermark> {
		return this.record("tombstone", { target })
	}

	async truncateBoundary(target: JournalWatermark): Promise<JournalWatermark> {
		return this.record("truncate_boundary", { target })
	}

	async supersedeRange(from: JournalWatermark, to: JournalWatermark): Promise<JournalWatermark> {
		if (compareWatermark(from, to) > 0) throw new Error("Supersede range must be ordered")
		return this.record("supersede_range", { range: { from, to } })
	}

	async checkpointMarker(checkpointRef: string): Promise<JournalWatermark> {
		return this.record("checkpoint_marker", { payloadRef: checkpointRef })
	}

	private record(kind: JournalEntryKind, entry: Omit<JournalEntry, "kind" | "watermark">): JournalWatermark {
		this.current = { epoch: this.current.epoch, seq: this.current.seq + 1 }
		this.entries.push({ ...entry, kind, watermark: this.current })
		return this.current
	}
}
