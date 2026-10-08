import { renderRetainedInputs } from "../../continuation/RetainedInputContent"
import type { JournalWatermark, QueuePayloadIdentity } from "../../kernel"
import type { ConversationJournal, TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"

export interface RetainedBatchIdentity {
	readonly deliveryId: string
	readonly entries: readonly QueuePayloadIdentity[]
}

interface RetainedBatchEnvelope extends UserInputEnvelope {
	readonly retainedInputBatch: RetainedBatchIdentity
}

export interface RetainedBatchReceipt extends RetainedBatchIdentity {
	readonly payloadRef: string
	readonly watermark: JournalWatermark
}

export type RetainedBatchEvidence =
	| { readonly kind: "absent" }
	| { readonly kind: "staged" | "retracted"; readonly receipt: RetainedBatchReceipt }

function stageOperation(deliveryId: string): string {
	return `intake.retained:${deliveryId}`
}

function retractOperation(deliveryId: string): string {
	return `intake.retained.retract:${deliveryId}`
}

function sameEntries(left: readonly QueuePayloadIdentity[], right: readonly QueuePayloadIdentity[]): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => entry.entryId === right[index]?.entryId && entry.payloadRef === right[index]?.payloadRef)
	)
}

function assertIdentity(input: RetainedBatchIdentity): void {
	if (
		!input.deliveryId ||
		!Array.isArray(input.entries) ||
		input.entries.length === 0 ||
		input.entries.some((entry) => !entry.entryId || !entry.payloadRef) ||
		new Set(input.entries.map((entry) => entry.entryId)).size !== input.entries.length
	)
		throw new Error("InvalidRetainedBatchIdentity")
}

/**
 * Persists one whole retained batch, never queue lifecycle state.
 *
 * The journal is the only authority for these facts. No receipt is cached, and
 * no method decides whether an intake entry is released or consumed. Negative
 * evidence is usable only after the owning writer has drained under the task
 * lock; a failed lookup throws rather than pretending the batch is absent.
 */
export class RetainedInputJournalBatch {
	constructor(
		private readonly payloads: TaskPayloadStore,
		private readonly journal: ConversationJournal,
	) {}

	async inspect(deliveryId: string): Promise<RetainedBatchEvidence> {
		const entry = await this.journal.findByOperation(stageOperation(deliveryId))
		if (!entry) return { kind: "absent" }
		if (entry.kind !== "message" || entry.source !== "intake" || !entry.payloadRef)
			throw new Error("InvalidRetainedBatchJournalEntry")
		const payload = decodeTaskPayload<RetainedBatchEnvelope>(await this.payloads.read(entry.payloadRef))
		if (payload.kind !== "user_input" || payload.retainedInputBatch?.deliveryId !== deliveryId)
			throw new Error("InvalidRetainedBatchPayload")
		assertIdentity(payload.retainedInputBatch)
		const receipt: RetainedBatchReceipt = {
			...payload.retainedInputBatch,
			payloadRef: entry.payloadRef,
			watermark: entry.watermark,
		}
		const retracted = await this.journal.findByOperation(retractOperation(deliveryId))
		if (retracted && (retracted.kind !== "tombstone" || retracted.target?.seq !== entry.watermark.seq))
			throw new Error("InvalidRetainedBatchRetraction")
		return { kind: retracted ? "retracted" : "staged", receipt }
	}

	async stage(
		input: RetainedBatchIdentity & {
			readonly generation: number
			readonly turnId?: string
			readonly signal: AbortSignal
		},
	): Promise<RetainedBatchReceipt> {
		assertIdentity(input)
		input.signal.throwIfAborted()
		const existing = await this.inspect(input.deliveryId)
		if (existing.kind !== "absent") {
			if (!sameEntries(existing.receipt.entries, input.entries)) throw new Error("RetainedBatchIdentityConflict")
			if (existing.kind === "retracted") throw new Error("RetainedBatchAlreadyRetracted")
			input.signal.throwIfAborted()
			return existing.receipt
		}
		const payloads = await Promise.all(
			input.entries.map(async (entry) => {
				const payload = decodeTaskPayload<UserInputEnvelope>(await this.payloads.read(entry.payloadRef))
				if (payload.kind !== "user_input") throw new Error(`InvalidRetainedInput:${entry.entryId}`)
				return payload
			}),
		)
		input.signal.throwIfAborted()
		const identity: RetainedBatchIdentity = {
			deliveryId: input.deliveryId,
			entries: input.entries.map((entry) => ({ ...entry })),
		}
		const envelope: RetainedBatchEnvelope = {
			kind: "user_input",
			retainedInputBatch: identity,
			text: payloads.map((payload) => payload.text ?? "").join("\n\n"),
			admittedText: renderRetainedInputs(payloads.map((payload) => payload.admittedText ?? payload.text ?? "")),
			images: payloads.flatMap((payload) => [...(payload.images ?? [])]),
			files: payloads.flatMap((payload) => [...(payload.files ?? [])]),
		}
		const payloadRef = await this.payloads.put(encodeTaskPayload(envelope))
		input.signal.throwIfAborted()
		const appended = await this.journal.append({
			operationId: stageOperation(input.deliveryId),
			payloadRef,
			source: "intake",
			causation: { generation: input.generation, ...(input.turnId === undefined ? {} : { turnId: input.turnId }) },
		})
		// An abort inside append cannot erase its durable fact. Return the receipt
		// so the caller can reconcile it instead of treating it as an unsent batch.
		return { ...identity, payloadRef, watermark: appended.watermark }
	}

	/** Retract only this staged row; all its inputs disappear from the projection together. */
	async retract(identity: RetainedBatchIdentity): Promise<RetainedBatchEvidence> {
		assertIdentity(identity)
		const evidence = await this.inspect(identity.deliveryId)
		if (evidence.kind === "absent") return evidence
		if (!sameEntries(identity.entries, evidence.receipt.entries)) throw new Error("RetainedBatchIdentityConflict")
		if (evidence.kind === "retracted") return evidence
		await this.journal.tombstone({ operationId: retractOperation(identity.deliveryId), target: evidence.receipt.watermark })
		return { kind: "retracted", receipt: evidence.receipt }
	}
}
