import { createHash } from "node:crypto"
import type { RegistrationGeneration, TaskIncarnationId, TaskIngressResolver } from "./TaskDirectory"

export interface AttestedDeliveryIntent {
	readonly deliveryId: string
	readonly fromTaskId: string
	readonly fromTaskIncarnationId: TaskIncarnationId
	readonly toTaskId: string
	readonly toTaskIncarnationId: TaskIncarnationId
	readonly targetRegistrationGeneration: RegistrationGeneration
	readonly senderPrincipalId: string
	readonly approvalRef: string
	readonly payloadRef: string
	readonly payloadHash: string
	readonly dedupeKey: string
}

export type ApprovalVerification =
	| { readonly kind: "verified"; readonly principalId: string }
	| { readonly kind: "stale" }
	| { readonly kind: "invalid" }
	| { readonly kind: "not_admitted" }

export interface ApprovalRefVerifier {
	verify(input: {
		readonly approvalRef: string
		readonly targetTaskId: string
		readonly targetTaskIncarnationId: TaskIncarnationId
		readonly targetRegistrationGeneration: RegistrationGeneration
	}): Promise<ApprovalVerification>
}

export interface DeliveryPayloadSource {
	read(payloadRef: string): Promise<Uint8Array>
}

export interface StagedTargetPayload {
	readonly stageId: string
	readonly targetTaskId: string
	readonly payloadHash: string
}

export interface TargetPayloadStore {
	stage(targetTaskId: string, payload: Uint8Array, payloadHash: string): Promise<StagedTargetPayload>
	commit(staged: StagedTargetPayload, entryId: string): Promise<string>
	rollback(staged: StagedTargetPayload): Promise<void>
	read(payloadRef: string): Promise<Uint8Array>
}

export type DeliveryAdmission =
	| { readonly kind: "admitted"; readonly entryId: string; readonly payloadRef: string }
	| { readonly kind: "duplicate"; readonly entryId: string; readonly payloadRef: string }
	| { readonly kind: "target_absent" }
	| { readonly kind: "target_closing" }
	| { readonly kind: "target_capacity_exceeded"; readonly pending: number; readonly limit: number }
	| { readonly kind: "stale" }
	| { readonly kind: "not_admitted"; readonly reason: string }

interface DeliveryRecord {
	readonly identity: string
	readonly entryId: string
	readonly payloadRef: string
}

function hash(payload: Uint8Array): string {
	return createHash("sha256").update(payload).digest("hex")
}

export class CoTaskDeliveryGateway {
	private readonly dedupe = new Map<string, DeliveryRecord>()
	private readonly targetTails = new Map<string, Promise<void>>()

	constructor(
		private readonly routes: TaskIngressResolver,
		private readonly approvals: ApprovalRefVerifier,
		private readonly source: DeliveryPayloadSource,
		private readonly targetPayloads: TargetPayloadStore,
	) {}

	deliver(intent: AttestedDeliveryIntent): Promise<DeliveryAdmission> {
		const previous = this.targetTails.get(intent.toTaskId) ?? Promise.resolve()
		let resolveTail!: () => void
		const tail = new Promise<void>((resolve) => (resolveTail = resolve))
		const chained = previous.then(() => tail)
		this.targetTails.set(intent.toTaskId, chained)
		return previous
			.then(() => this.deliverSerial(intent))
			.finally(() => {
				resolveTail()
				if (this.targetTails.get(intent.toTaskId) === chained) this.targetTails.delete(intent.toTaskId)
			})
	}

	private async deliverSerial(intent: AttestedDeliveryIntent): Promise<DeliveryAdmission> {
		const route = this.routes.resolve(intent.toTaskId)
		if (!route) return { kind: "target_absent" }
		if (
			route.descriptor.taskIncarnationId !== intent.toTaskIncarnationId ||
			route.descriptor.registrationGeneration !== intent.targetRegistrationGeneration
		)
			return { kind: "stale" }
		const verified = await this.approvals.verify({
			approvalRef: intent.approvalRef,
			targetTaskId: intent.toTaskId,
			targetTaskIncarnationId: intent.toTaskIncarnationId,
			targetRegistrationGeneration: intent.targetRegistrationGeneration,
		})
		if (verified.kind === "stale") return { kind: "stale" }
		if (verified.kind !== "verified" || verified.principalId !== intent.senderPrincipalId)
			return { kind: "not_admitted", reason: "approval_not_verified" }
		const identity = `${intent.deliveryId}:${intent.payloadHash}:${intent.senderPrincipalId}`
		const dedupeKey = `${intent.toTaskId}:${intent.toTaskIncarnationId}:${intent.targetRegistrationGeneration}:${intent.senderPrincipalId}:${intent.dedupeKey}`
		const existing = this.dedupe.get(dedupeKey)
		if (existing) {
			return existing.identity === identity
				? { kind: "duplicate", entryId: existing.entryId, payloadRef: existing.payloadRef }
				: { kind: "not_admitted", reason: "dedupe_conflict" }
		}

		const payload = await this.source.read(intent.payloadRef)
		if (hash(payload) !== intent.payloadHash) return { kind: "not_admitted", reason: "payload_hash_mismatch" }
		const currentRoute = this.routes.resolve(intent.toTaskId)
		if (
			!currentRoute ||
			currentRoute.descriptor.taskIncarnationId !== intent.toTaskIncarnationId ||
			currentRoute.descriptor.registrationGeneration !== intent.targetRegistrationGeneration
		)
			return { kind: "stale" }
		const ingress = currentRoute.ingress.snapshot()
		if (ingress.closing) return { kind: "target_closing" }
		if (ingress.pending >= ingress.limit)
			return { kind: "target_capacity_exceeded", pending: ingress.pending, limit: ingress.limit }

		const entryId = `cotask:${intent.deliveryId}`
		const staged = await this.targetPayloads.stage(intent.toTaskId, payload, intent.payloadHash)
		try {
			const targetPayloadRef = await this.targetPayloads.commit(staged, entryId)
			await currentRoute.ingress.accept({
				entryId,
				payloadRef: targetPayloadRef,
				sourceTaskId: intent.fromTaskId,
				dedupeKey: intent.dedupeKey,
			})
			this.dedupe.set(dedupeKey, { identity, entryId, payloadRef: targetPayloadRef })
			return { kind: "admitted", entryId, payloadRef: targetPayloadRef }
		} catch (error) {
			await this.targetPayloads.rollback(staged)
			throw error
		}
	}
}

export class InMemoryTargetPayloadStore implements TargetPayloadStore {
	private sequence = 0
	private readonly staged = new Map<string, Uint8Array>()
	private readonly committed = new Map<string, Uint8Array>()

	async stage(targetTaskId: string, payload: Uint8Array, payloadHash: string): Promise<StagedTargetPayload> {
		const stageId = `${targetTaskId}:${++this.sequence}`
		this.staged.set(stageId, payload.slice())
		return { stageId, targetTaskId, payloadHash }
	}

	async commit(staged: StagedTargetPayload, entryId: string): Promise<string> {
		const payload = this.staged.get(staged.stageId)
		if (!payload) throw new Error("TargetPayloadStageMissing")
		const payloadRef = `${staged.targetTaskId}:payload:${entryId}`
		this.committed.set(payloadRef, payload)
		this.staged.delete(staged.stageId)
		return payloadRef
	}

	async rollback(staged: StagedTargetPayload): Promise<void> {
		this.staged.delete(staged.stageId)
	}

	async read(payloadRef: string): Promise<Uint8Array> {
		const payload = this.committed.get(payloadRef)
		if (!payload) throw new Error("TargetPayloadMissing")
		return payload.slice()
	}
}
