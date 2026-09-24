import { mkdir, open, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type {
	ConversationJournal,
	JournalAppendInput,
	JournalAppendResult,
	JournalEntry,
	JournalEntryKind,
	JournalWatermark,
} from "./contracts"
import { compareJournalWatermarks, rebuildJournalProjection } from "./JournalProjection"

const SEGMENT_PATTERN = /^epoch-(\d{6})\.jsonl$/

function segmentName(epoch: number): string {
	return `epoch-${epoch.toString().padStart(6, "0")}.jsonl`
}

function operationFingerprint(
	kind: JournalEntryKind,
	entry: Omit<JournalEntry, "version" | "operationId" | "kind" | "watermark">,
): string {
	return JSON.stringify({ kind, entry })
}

function decodedFingerprint(entry: JournalEntry): string {
	const { version: _version, operationId: _operationId, kind, watermark: _watermark, ...content } = entry
	return operationFingerprint(kind, content)
}

function decodeEntry(line: string): JournalEntry {
	const value = JSON.parse(line) as Partial<JournalEntry>
	if (
		value.version !== 1 ||
		typeof value.operationId !== "string" ||
		typeof value.kind !== "string" ||
		!value.watermark ||
		!Number.isInteger(value.watermark.epoch) ||
		!Number.isInteger(value.watermark.seq)
	)
		throw new Error("InvalidJournalRecord")
	return value as JournalEntry
}

export interface SegmentedConversationJournalOptions {
	readonly directory: string
	readonly taskId: string
}

export class SegmentedConversationJournal implements ConversationJournal {
	private current: JournalWatermark = { epoch: 0, seq: 0 }
	private readonly entries: JournalEntry[] = []
	private readonly operations = new Map<string, { readonly fingerprint: string; readonly entry: JournalEntry }>()
	private readonly transient = new Map<string, string>()
	private writeTail: Promise<void> = Promise.resolve()
	private needsRecoveryRebase = false

	private constructor(private readonly options: SegmentedConversationJournalOptions) {}

	static async open(options: SegmentedConversationJournalOptions): Promise<SegmentedConversationJournal> {
		const journal = new SegmentedConversationJournal(options)
		await journal.load()
		return journal
	}

	watermark(): JournalWatermark {
		return this.current
	}

	append(input: JournalAppendInput): Promise<JournalAppendResult> {
		return this.enqueue(() =>
			this.record("message", input.operationId, {
				payloadRef: input.payloadRef,
				source: input.source,
				causation: input.causation,
			}),
		)
	}

	async read(after?: JournalWatermark, through?: JournalWatermark): Promise<readonly JournalEntry[]> {
		await this.writeTail
		return this.entries.filter(
			(entry) =>
				(!after || compareJournalWatermarks(entry.watermark, after) > 0) &&
				(!through || compareJournalWatermarks(entry.watermark, through) <= 0),
		)
	}

	async findByOperation(operationId: string): Promise<JournalEntry | undefined> {
		await this.writeTail
		return this.operations.get(operationId)?.entry
	}

	async project(through = this.current) {
		await this.writeTail
		return rebuildJournalProjection(this.entries, through)
	}

	appendTransient(transientId: string, payloadRef: string): void {
		this.transient.set(transientId, payloadRef)
	}

	finalizeTransient(input: JournalAppendInput & { readonly transientId: string }): Promise<JournalAppendResult> {
		return this.enqueue(async () => {
			const resolved = input.payloadRef || this.transient.get(input.transientId)
			if (!resolved) throw new Error(`Unknown transient journal entry: ${input.transientId}`)
			const result = await this.record("message", input.operationId, {
				payloadRef: resolved,
				source: input.source,
				causation: input.causation,
				transientId: input.transientId,
			})
			this.transient.delete(input.transientId)
			return result
		})
	}

	rebase(input: { readonly operationId: string; readonly reasonRef: string }): Promise<JournalAppendResult> {
		return this.enqueue(async () => {
			const previousTail = this.current
			const existing = this.idempotent(input.operationId, "rebase", { payloadRef: input.reasonRef, previousTail })
			if (existing) return existing
			this.current = { epoch: this.current.epoch + 1, seq: 0 }
			this.needsRecoveryRebase = false
			return this.record("rebase", input.operationId, { payloadRef: input.reasonRef, previousTail }, false)
		})
	}

	rewind(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult> {
		return this.enqueue(() => this.record("rewind", input.operationId, { target: input.target }))
	}

	tombstone(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult> {
		return this.enqueue(() => this.record("tombstone", input.operationId, { target: input.target }))
	}

	truncateBoundary(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult> {
		return this.enqueue(() => this.record("truncate_boundary", input.operationId, { target: input.target }))
	}

	supersedeRange(input: {
		readonly operationId: string
		readonly from: JournalWatermark
		readonly to: JournalWatermark
		readonly replacementRef?: string
	}): Promise<JournalAppendResult> {
		return this.enqueue(() => {
			if (compareJournalWatermarks(input.from, input.to) > 0) throw new Error("Supersede range must be ordered")
			return this.record("supersede_range", input.operationId, {
				range: { from: input.from, to: input.to },
				...(input.replacementRef === undefined ? {} : { payloadRef: input.replacementRef }),
			})
		})
	}

	checkpointMarker(input: { readonly operationId: string; readonly checkpointRef: string }): Promise<JournalAppendResult> {
		return this.enqueue(() => this.record("checkpoint_marker", input.operationId, { payloadRef: input.checkpointRef }))
	}

	private async load(): Promise<void> {
		await mkdir(this.options.directory, { recursive: true })
		const segments = (await readdir(this.options.directory))
			.map((name) => ({ name, match: name.match(SEGMENT_PATTERN) }))
			.filter((entry): entry is { name: string; match: RegExpMatchArray } => entry.match !== null)
			.sort((left, right) => Number(left.match[1]) - Number(right.match[1]))

		for (const [segmentIndex, segment] of segments.entries()) {
			const content = await readFile(join(this.options.directory, segment.name), "utf8")
			const isLast = segmentIndex === segments.length - 1
			const complete = content.endsWith("\n")
			const lines = content.split("\n")
			if (lines.at(-1) === "") lines.pop()
			for (const [lineIndex, line] of lines.entries()) {
				if (!line) continue
				try {
					this.adopt(decodeEntry(line))
				} catch (error) {
					if (isLast && !complete && lineIndex === lines.length - 1) {
						this.needsRecoveryRebase = true
						break
					}
					throw error
				}
			}
		}
		rebuildJournalProjection(this.entries, this.current)
	}

	private adopt(entry: JournalEntry): void {
		const existing = this.operations.get(entry.operationId)
		const fingerprint = decodedFingerprint(entry)
		if (existing && existing.fingerprint !== fingerprint) throw new Error(`Journal operation conflict: ${entry.operationId}`)
		if (existing) throw new Error(`DuplicateJournalOperation: ${entry.operationId}`)
		this.entries.push(entry)
		this.operations.set(entry.operationId, { fingerprint, entry })
		this.current = entry.watermark
	}

	private enqueue<T>(work: () => Promise<T> | T): Promise<T> {
		const result = this.writeTail.then(work)
		this.writeTail = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	private idempotent(
		operationId: string,
		kind: JournalEntryKind,
		entry: Omit<JournalEntry, "version" | "operationId" | "kind" | "watermark">,
	): JournalAppendResult | undefined {
		const fingerprint = operationFingerprint(kind, entry)
		const existing = this.operations.get(operationId)
		if (!existing) return undefined
		if (existing.fingerprint !== fingerprint) throw new Error(`Journal operation conflict: ${operationId}`)
		return { watermark: existing.entry.watermark, disposition: "existing" }
	}

	private async ensureWritableSegment(): Promise<void> {
		if (!this.needsRecoveryRebase) return
		const previousTail = this.current
		this.current = { epoch: this.current.epoch + 1, seq: 0 }
		this.needsRecoveryRebase = false
		await this.record(
			"rebase",
			`system:torn-tail-recovery:${this.current.epoch}`,
			{ payloadRef: "torn_tail_recovery", previousTail },
			false,
		)
	}

	private async record(
		kind: JournalEntryKind,
		operationId: string,
		entry: Omit<JournalEntry, "version" | "operationId" | "kind" | "watermark">,
		ensureSegment = true,
	): Promise<JournalAppendResult> {
		const existing = this.idempotent(operationId, kind, entry)
		if (existing) return existing
		if (ensureSegment) await this.ensureWritableSegment()
		const watermark = { epoch: this.current.epoch, seq: this.current.seq + 1 }
		const recorded: JournalEntry = { ...entry, version: 1, operationId, kind, watermark }
		const handle = await open(join(this.options.directory, segmentName(watermark.epoch)), "a")
		try {
			await handle.write(`${JSON.stringify(recorded)}\n`)
			await handle.sync()
		} finally {
			await handle.close()
		}
		this.adopt(recorded)
		return { watermark, disposition: "appended" }
	}
}
