import { type Command, type JournalWatermark, requiredPayloadRefs, type TaskState } from "../kernel"
import { commandEffectKey } from "../runtime/DurableCommandOutbox"
import type { ConversationJournal, DurableTaskSnapshot, StateVault, TaskPayloadStore } from "../stores"
import { compareJournalWatermarks } from "../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"

interface CanonicalCheckpointBundleV1 {
	readonly version: 1
	readonly taskId: string
	readonly checkpointRef: string
	readonly snapshot: DurableTaskSnapshot
	readonly boundary: JournalWatermark
	readonly workspaceRef?: string
}

export interface CanonicalCheckpointRecord {
	readonly snapshot: DurableTaskSnapshot
	readonly boundary: JournalWatermark
	readonly workspaceRef?: string
}

export interface CaptureCanonicalCheckpointInput {
	readonly checkpointRef: string
	readonly workspaceRef?: string
}

export interface CanonicalCheckpointRepositoryOptions {
	readonly taskId: string
	readonly vault: StateVault
	readonly journal: ConversationJournal
	readonly payloads: TaskPayloadStore
}

function markerOperation(checkpointRef: string): string {
	return `checkpoint.capture:${checkpointRef}`
}

function assertBoundary(boundary: JournalWatermark): void {
	if (!Number.isSafeInteger(boundary.seq) || boundary.seq < 0) throw new Error("InvalidCanonicalCheckpointBoundary")
}

function decodeBundle(payload: Uint8Array, taskId: string, checkpointRef: string): CanonicalCheckpointBundleV1 {
	const value = decodeTaskPayload<Partial<CanonicalCheckpointBundleV1> | null>(payload)
	if (
		value?.version !== 1 ||
		value.taskId !== taskId ||
		value.checkpointRef !== checkpointRef ||
		!value.snapshot?.state ||
		!Array.isArray(value.snapshot.outbox) ||
		!value.boundary
	) {
		throw new Error("InvalidCanonicalCheckpointBundle")
	}
	assertBoundary(value.boundary)
	if (value.snapshot.state.taskId !== taskId) throw new Error("CanonicalCheckpointIdentityMismatch")
	return value as CanonicalCheckpointBundleV1
}

/**
 * Stores immutable task checkpoints beside the journal they describe.
 *
 * Payload persistence happens before the marker is appended. The marker is the
 * commit point: a crash may leave an unreferenced content-addressed payload, but
 * every visible checkpoint marker resolves to a complete bundle.
 */
export class CanonicalCheckpointRepository {
	constructor(private readonly options: CanonicalCheckpointRepositoryOptions) {}

	async capture(input: CaptureCanonicalCheckpointInput): Promise<CanonicalCheckpointRecord> {
		const existing = await this.findMarker(input.checkpointRef)
		if (existing) {
			const record = await this.readRecord(input.checkpointRef, existing)
			if (input.workspaceRef !== undefined && record.workspaceRef !== input.workspaceRef) {
				throw new Error("CanonicalCheckpointWorkspaceConflict")
			}
			return record
		}

		const snapshot = await this.options.vault.load(this.options.taskId)
		if (!snapshot) throw new Error("CanonicalCheckpointSnapshotMissing")
		if (snapshot.state.taskId !== this.options.taskId) throw new Error("CanonicalCheckpointIdentityMismatch")
		const boundary = snapshot.state.journalWatermark ?? { seq: 0 }
		assertBoundary(boundary)
		if (compareJournalWatermarks(boundary, this.options.journal.watermark()) > 0) {
			throw new Error("CanonicalCheckpointBoundaryAhead")
		}
		await this.assertPayloadClosure(snapshot.state)
		const bundle: CanonicalCheckpointBundleV1 = {
			version: 1,
			taskId: this.options.taskId,
			checkpointRef: input.checkpointRef,
			snapshot,
			boundary,
			...(input.workspaceRef === undefined ? {} : { workspaceRef: input.workspaceRef }),
		}
		const bundleRef = await this.options.payloads.put(encodeTaskPayload(bundle))
		await this.options.journal.checkpointMarker({
			operationId: markerOperation(input.checkpointRef),
			checkpointRef: bundleRef,
		})
		return { snapshot, boundary, ...(input.workspaceRef === undefined ? {} : { workspaceRef: input.workspaceRef }) }
	}

	async resolve(checkpointRef: string): Promise<CanonicalCheckpointRecord> {
		const marker = await this.findMarker(checkpointRef)
		if (!marker) throw new Error("CanonicalCheckpointNotFound")
		return this.readRecord(checkpointRef, marker)
	}

	private async findMarker(checkpointRef: string): Promise<string | undefined> {
		const marker = await this.options.journal.findByOperation(markerOperation(checkpointRef))
		if (!marker) return undefined
		if (marker.kind !== "checkpoint_marker" || !marker.payloadRef) throw new Error("InvalidCanonicalCheckpointMarker")
		return marker.payloadRef
	}

	private async readRecord(checkpointRef: string, bundleRef: string): Promise<CanonicalCheckpointRecord> {
		const bundle = decodeBundle(await this.options.payloads.read(bundleRef), this.options.taskId, checkpointRef)
		await this.assertPayloadClosure(bundle.snapshot.state)
		return {
			snapshot: bundle.snapshot,
			boundary: bundle.boundary,
			...(bundle.workspaceRef === undefined ? {} : { workspaceRef: bundle.workspaceRef }),
		}
	}

	private async assertPayloadClosure(state: TaskState): Promise<void> {
		for (const payloadRef of requiredPayloadRefs(state)) {
			try {
				await this.options.payloads.read(payloadRef)
			} catch {
				throw new Error(`CanonicalCheckpointPayloadMissing:${payloadRef}`)
			}
		}
	}
}

/** Merge a stored outbox with commands hydrate requires, preserving effect identity. */
export function mergeCheckpointOutbox(stored: readonly Command[], recovered: readonly Command[]): readonly Command[] {
	const merged = new Map<string, Command>()
	for (const command of [...stored, ...recovered]) merged.set(commandEffectKey(command), command)
	return [...merged.values()]
}

export function canonicalCheckpointRef(taskId: string, messageTs: number): string {
	if (!Number.isSafeInteger(messageTs) || messageTs <= 0) throw new Error("InvalidCanonicalCheckpointMessageTs")
	return `${taskId}:message:${messageTs}`
}
