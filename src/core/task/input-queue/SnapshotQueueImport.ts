import { readFile } from "node:fs/promises"
import { getTaskSnapshotPath } from "@core/storage/disk"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { validateSemanticInputDocument } from "@shared/input-semantics/validation"
import { hashStableJson } from "@shared/stable-json"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import { createInitialTaskState, type IntakeEntry, type JournalWatermark, type SnapshotQueueImportMarker } from "../kernel"
import type { StateVault, TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"

export interface SnapshotQueueDocument {
	readonly fingerprint: string
	readonly entries: readonly unknown[]
}

/** The input queue an earlier version kept in `snapshot.json.inputQueue`. */
export interface SnapshotQueueSource {
	read(): Promise<SnapshotQueueDocument | undefined>
	removeInputQueue(expectedFingerprint: string): Promise<void>
}

export type SnapshotQueueImportResult =
	| {
			readonly kind: "none"
			readonly importedEntries: 0
			readonly skippedDeliveringEntries: 0
			readonly skippedInvalidEntries: 0
	  }
	| {
			readonly kind: "imported" | "cleaned"
			readonly importedEntries: number
			readonly skippedDeliveringEntries: number
			readonly skippedInvalidEntries: number
	  }

export class SnapshotQueueChangedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SnapshotQueueChangedError"
	}
}

/** `state.json` holds the imported queue; only removing it from `snapshot.json` remains to retry. */
export class SnapshotQueueCleanupPendingError extends Error {
	override readonly cause: unknown

	constructor(cause: unknown) {
		super("The input queue was imported into state.json, but could not be removed from snapshot.json")
		this.name = "SnapshotQueueCleanupPendingError"
		this.cause = cause
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringList(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function semanticInput(value: unknown): SemanticInputDocument | undefined {
	const candidate = record(value) as SemanticInputDocument | undefined
	if (!candidate) return undefined
	try {
		return validateSemanticInputDocument(candidate).length === 0 ? candidate : undefined
	} catch {
		return undefined
	}
}

function sourceFingerprint(entries: readonly unknown[]): string {
	return hashStableJson(entries)
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

function parseSnapshot(value: unknown): Record<string, unknown> {
	const parsed = record(value)
	if (!parsed) throw new SnapshotQueueChangedError("snapshot.json is not a JSON object")
	return parsed
}

/** File-backed source that removes only the retired field and preserves every unrelated snapshot property. */
export class SnapshotQueueFile implements SnapshotQueueSource {
	constructor(private readonly filePath: string) {}

	async read(): Promise<SnapshotQueueDocument | undefined> {
		let raw: string
		try {
			raw = await readFile(this.filePath, "utf8")
		} catch (error) {
			if (isMissingFile(error)) return undefined
			throw error
		}
		let snapshot: Record<string, unknown>
		try {
			snapshot = parseSnapshot(JSON.parse(raw))
		} catch (error) {
			if (error instanceof SnapshotQueueChangedError) throw error
			throw new SnapshotQueueChangedError(`snapshot.json cannot be decoded: ${String(error)}`)
		}
		if (!("inputQueue" in snapshot)) return undefined
		if (!Array.isArray(snapshot.inputQueue)) {
			throw new SnapshotQueueChangedError("snapshot.json inputQueue is not an array")
		}
		return { entries: snapshot.inputQueue, fingerprint: sourceFingerprint(snapshot.inputQueue) }
	}

	async removeInputQueue(expectedFingerprint: string): Promise<void> {
		let raw: string
		try {
			raw = await readFile(this.filePath, "utf8")
		} catch (error) {
			if (isMissingFile(error)) return
			throw error
		}
		let snapshot: Record<string, unknown>
		try {
			snapshot = parseSnapshot(JSON.parse(raw))
		} catch (error) {
			if (error instanceof SnapshotQueueChangedError) throw error
			throw new SnapshotQueueChangedError(`snapshot.json cannot be decoded during cleanup: ${String(error)}`)
		}
		if (!("inputQueue" in snapshot)) return
		if (!Array.isArray(snapshot.inputQueue)) {
			throw new SnapshotQueueChangedError("snapshot.json inputQueue changed to a non-array value")
		}
		const currentFingerprint = sourceFingerprint(snapshot.inputQueue)
		if (currentFingerprint !== expectedFingerprint) {
			throw new SnapshotQueueChangedError(
				`snapshot.json inputQueue changed before cleanup (${expectedFingerprint} != ${currentFingerprint})`,
			)
		}
		const { inputQueue: _retired, ...remaining } = snapshot
		await writeJsonAtomic(this.filePath, remaining)
	}
}

export async function snapshotQueueSource(taskId: string): Promise<SnapshotQueueSource> {
	return new SnapshotQueueFile(await getTaskSnapshotPath(taskId))
}

interface NormalizedQueueInput {
	readonly entryId: string
	readonly mode: "queued" | "steering"
	readonly envelope: UserInputEnvelope
}

interface NormalizedQueue {
	readonly entries: readonly NormalizedQueueInput[]
	readonly skippedDelivering: number
	readonly skippedInvalid: number
}

function normalizedIdentity(
	raw: Record<string, unknown>,
	index: number,
	fingerprint: string,
	existingIds: ReadonlySet<string>,
	importedIds: Set<string>,
): string {
	const requested =
		typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `snapshot-input-${fingerprint.slice(7, 19)}-${index}`
	if (existingIds.has(requested)) {
		throw new SnapshotQueueChangedError(`snapshot.json inputQueue entry id already exists in state.json: ${requested}`)
	}
	if (!importedIds.has(requested)) return requested
	let suffix = 1
	let candidate = `${requested}-imported-${index}-${suffix}`
	while (existingIds.has(candidate) || importedIds.has(candidate)) {
		suffix += 1
		candidate = `${requested}-imported-${index}-${suffix}`
	}
	return candidate
}

function normalizeQueue(values: readonly unknown[], fingerprint: string, existingIds: ReadonlySet<string>): NormalizedQueue {
	const entries: NormalizedQueueInput[] = []
	const importedIds = new Set<string>()
	let skippedDelivering = 0
	let skippedInvalid = 0
	for (let index = 0; index < values.length; index += 1) {
		const raw = record(values[index])
		if (!raw || typeof raw.text !== "string") {
			skippedInvalid += 1
			continue
		}
		if (raw.delivering === true) {
			skippedDelivering += 1
			continue
		}
		const entryId = normalizedIdentity(raw, index, fingerprint, existingIds, importedIds)
		importedIds.add(entryId)
		const document = semanticInput(raw.semanticInput)
		entries.push({
			entryId,
			mode: raw.mode === "steering" ? "steering" : "queued",
			envelope: {
				kind: "user_input",
				text: raw.text,
				images: stringList(raw.images),
				files: stringList(raw.files),
				...(typeof raw.activeQuote === "string" ? { activeQuote: raw.activeQuote } : {}),
				...(document ? { semanticInput: document } : {}),
			},
		})
	}
	return { entries, skippedDelivering, skippedInvalid }
}

function migrationResult(kind: "imported" | "cleaned", marker: SnapshotQueueImportMarker): SnapshotQueueImportResult {
	return {
		kind,
		importedEntries: marker.importedEntryCount,
		skippedDeliveringEntries: marker.skippedDeliveringCount,
		skippedInvalidEntries: marker.skippedInvalidCount,
	}
}

async function retireSource(source: SnapshotQueueSource, marker: SnapshotQueueImportMarker): Promise<void> {
	try {
		await source.removeInputQueue(marker.sourceFingerprint)
	} catch (error) {
		if (error instanceof SnapshotQueueChangedError) throw error
		throw new SnapshotQueueCleanupPendingError(error)
	}
}

/**
 * Imports `snapshot.json.inputQueue` into `state.json` exactly once.
 *
 * Payload writes are content addressed. The state and marker are saved together
 * before the old field is removed, so a failed cleanup can only retry cleanup;
 * it can never enqueue the same user input twice.
 *
 * A task with no `state.json` yet gets one positioned at `journalTail`: the
 * conversation imported ahead of this is already the task's history, so a
 * checkpoint or restored dialog must not treat it as unread.
 */
export async function importSnapshotQueue(input: {
	readonly taskId: string
	readonly source: SnapshotQueueSource
	readonly vault: StateVault
	readonly payloads: TaskPayloadStore
	readonly journalTail: JournalWatermark
}): Promise<SnapshotQueueImportResult> {
	const source = await input.source.read()
	if (!source) {
		return { kind: "none", importedEntries: 0, skippedDeliveringEntries: 0, skippedInvalidEntries: 0 }
	}
	const durable = await input.vault.load(input.taskId)
	const existingMarker = durable?.state.snapshotQueueImport
	if (existingMarker) {
		if (existingMarker.sourceFingerprint !== source.fingerprint) {
			throw new SnapshotQueueChangedError(
				`snapshot.json inputQueue changed after it was imported (${existingMarker.sourceFingerprint} != ${source.fingerprint})`,
			)
		}
		await retireSource(input.source, existingMarker)
		return migrationResult("cleaned", existingMarker)
	}

	const base = durable ?? {
		state: { ...createInitialTaskState(input.taskId), journalWatermark: input.journalTail },
		outbox: [],
	}
	if (base.state.intake.queued.some((entry) => entry.queue !== undefined && entry.state !== "consumed")) {
		throw new SnapshotQueueChangedError("state.json already retains input but records no snapshot.json import")
	}
	const existingIds = new Set(base.state.intake.queued.map((entry) => entry.entryId))
	const normalized = normalizeQueue(source.entries, source.fingerprint, existingIds)
	const firstSequence = Math.max(-1, ...base.state.intake.queued.map((entry) => entry.sequence)) + 1
	const imported: IntakeEntry[] = []
	for (let index = 0; index < normalized.entries.length; index += 1) {
		const entry = normalized.entries[index]
		const payloadRef = await input.payloads.put(encodeTaskPayload(entry.envelope))
		imported.push({
			entryId: entry.entryId,
			payloadRef,
			source: "user",
			mode: entry.mode,
			sequence: firstSequence + index,
			queue: { editing: false },
			state: "accepted",
		})
	}
	const marker: SnapshotQueueImportMarker = {
		sourceFingerprint: source.fingerprint,
		importedEntryCount: imported.length,
		skippedDeliveringCount: normalized.skippedDelivering,
		skippedInvalidCount: normalized.skippedInvalid,
	}
	await input.vault.save({
		state: {
			...base.state,
			intake: { ...base.state.intake, queued: [...base.state.intake.queued, ...imported] },
			snapshotQueueImport: marker,
		},
		outbox: base.outbox,
	})
	await retireSource(input.source, marker)
	return migrationResult("imported", marker)
}
