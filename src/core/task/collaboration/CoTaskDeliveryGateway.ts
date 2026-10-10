import { createHash } from "node:crypto"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { CoTaskMessageEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { CoTaskApprovalLedger } from "./CoTaskApprovalLedger"
import type {
    CoTaskIngressSnapshot,
    InternalCoTaskIngress,
    RegistrationGeneration,
    TaskDescriptor,
    TaskIncarnationId,
} from "./TaskDirectory"

export interface CoTaskDeliveryAuthorizationRequest {
    readonly deliveryId: string
    readonly fromTaskId: string
    readonly fromTaskIncarnationId: TaskIncarnationId
    readonly toTaskId: string
    readonly dedupeKey: string
    readonly text: string
}

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

export type DeliveryAuthorization =
    | { readonly kind: "authorized"; readonly intent: AttestedDeliveryIntent }
    | { readonly kind: "source_absent" }
    | { readonly kind: "source_closing" }
    | { readonly kind: "target_absent" }
    | { readonly kind: "target_closing" }
    | { readonly kind: "stale" }

export interface CoTaskSessionLease {
    readonly descriptor: TaskDescriptor
    readonly payloads: TaskPayloadStore
    readonly ingress: InternalCoTaskIngress
    release(): void
}

export type CoTaskSessionLeaseResult =
    | { readonly kind: "acquired"; readonly lease: CoTaskSessionLease }
    | { readonly kind: "absent" }
    | { readonly kind: "closing" }
    | { readonly kind: "stale" }

export interface CoTaskSessionLeaseResolver {
    acquire(input: {
        readonly taskId: string
        readonly expectedTaskIncarnationId?: TaskIncarnationId
        readonly expectedRegistrationGeneration?: RegistrationGeneration
    }): CoTaskSessionLeaseResult
}

export type DeliveryAdmission =
    | { readonly kind: "admitted"; readonly entryId: string; readonly payloadRef: string }
    | { readonly kind: "duplicate"; readonly entryId: string; readonly payloadRef: string }
    | { readonly kind: "source_absent" }
    | { readonly kind: "source_closing" }
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

function principalFor(descriptor: TaskDescriptor): string {
    return `task:${descriptor.taskId}:${descriptor.taskIncarnationId}`
}

function authorizationFailure(
    result: Exclude<CoTaskSessionLeaseResult, { readonly kind: "acquired" }>,
    role: "source" | "target",
): DeliveryAuthorization {
    if (result.kind === "stale") return { kind: "stale" }
    return { kind: `${role}_${result.kind}` as "source_absent" | "source_closing" | "target_absent" | "target_closing" }
}

function deliveryFailure(
    result: Exclude<CoTaskSessionLeaseResult, { readonly kind: "acquired" }>,
    role: "source" | "target",
): DeliveryAdmission {
    if (result.kind === "stale") return { kind: "stale" }
    return { kind: `${role}_${result.kind}` as "source_absent" | "source_closing" | "target_absent" | "target_closing" }
}

function capacity(snapshot: CoTaskIngressSnapshot): DeliveryAdmission | undefined {
    return snapshot.pending >= snapshot.limit
        ? { kind: "target_capacity_exceeded", pending: snapshot.pending, limit: snapshot.limit }
        : undefined
}

/** The single production gateway for authorized process-local task-to-task delivery. */
export class CoTaskDeliveryGateway {
    private readonly dedupe = new Map<string, DeliveryRecord>()
    private readonly targetTails = new Map<string, Promise<void>>()

    constructor(
        private readonly sessions: CoTaskSessionLeaseResolver,
        private readonly approvals: CoTaskApprovalLedger,
    ) {}

    async authorize(request: CoTaskDeliveryAuthorizationRequest): Promise<DeliveryAuthorization> {
        const sourceResult = this.sessions.acquire({
            taskId: request.fromTaskId,
            expectedTaskIncarnationId: request.fromTaskIncarnationId,
        })
        if (sourceResult.kind !== "acquired") return authorizationFailure(sourceResult, "source")
        const targetResult = this.sessions.acquire({ taskId: request.toTaskId })
        if (targetResult.kind !== "acquired") {
            sourceResult.lease.release()
            return authorizationFailure(targetResult, "target")
        }
        try {
            const senderPrincipalId = principalFor(sourceResult.lease.descriptor)
            const envelope: CoTaskMessageEnvelope = {
                kind: "cotask_message",
                text: request.text,
                source: {
                    taskId: sourceResult.lease.descriptor.taskId,
                    taskIncarnationId: sourceResult.lease.descriptor.taskIncarnationId,
                    principalId: senderPrincipalId,
                    deliveryId: request.deliveryId,
                },
            }
            const bytes = encodeTaskPayload(envelope)
            const payloadRef = await sourceResult.lease.payloads.put(bytes)
            const scope = {
                deliveryId: request.deliveryId,
                fromTaskId: request.fromTaskId,
                fromTaskIncarnationId: request.fromTaskIncarnationId,
                toTaskId: request.toTaskId,
                toTaskIncarnationId: targetResult.lease.descriptor.taskIncarnationId,
                targetRegistrationGeneration: targetResult.lease.descriptor.registrationGeneration,
                senderPrincipalId,
                payloadRef,
                payloadHash: hash(bytes),
                dedupeKey: request.dedupeKey,
            }
            const grant = this.approvals.issue(scope)
            return { kind: "authorized", intent: { ...scope, approvalRef: grant.approvalRef } }
        } finally {
            targetResult.lease.release()
            sourceResult.lease.release()
        }
    }

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
        const sourceResult = this.sessions.acquire({
            taskId: intent.fromTaskId,
            expectedTaskIncarnationId: intent.fromTaskIncarnationId,
        })
        if (sourceResult.kind !== "acquired") return deliveryFailure(sourceResult, "source")
        const targetResult = this.sessions.acquire({
            taskId: intent.toTaskId,
            expectedTaskIncarnationId: intent.toTaskIncarnationId,
            expectedRegistrationGeneration: intent.targetRegistrationGeneration,
        })
        if (targetResult.kind !== "acquired") {
            sourceResult.lease.release()
            return deliveryFailure(targetResult, "target")
        }
        try {
            const verified = await this.approvals.verify(intent)
            if (verified.kind === "stale") return { kind: "stale" }
            if (verified.kind !== "verified" || verified.principalId !== intent.senderPrincipalId)
                return { kind: "not_admitted", reason: "approval_not_verified" }

            const identity = `${intent.deliveryId}:${intent.payloadHash}:${intent.senderPrincipalId}`
            const dedupeKey = [
                intent.toTaskId,
                intent.toTaskIncarnationId,
                intent.targetRegistrationGeneration,
                intent.fromTaskId,
                intent.fromTaskIncarnationId,
                intent.senderPrincipalId,
                intent.dedupeKey,
            ].join(":")
            const existing = this.dedupe.get(dedupeKey)
            if (existing) {
                return existing.identity === identity
                    ? { kind: "duplicate", entryId: existing.entryId, payloadRef: existing.payloadRef }
                    : { kind: "not_admitted", reason: "dedupe_conflict" }
            }

            const payload = await sourceResult.lease.payloads.read(intent.payloadRef)
            if (hash(payload) !== intent.payloadHash) return { kind: "not_admitted", reason: "payload_hash_mismatch" }
            let envelope: CoTaskMessageEnvelope
            try {
                envelope = decodeTaskPayload<CoTaskMessageEnvelope>(payload)
            } catch {
                return { kind: "not_admitted", reason: "invalid_payload" }
            }
            if (
                envelope.kind !== "cotask_message" ||
                envelope.source.taskId !== intent.fromTaskId ||
                envelope.source.taskIncarnationId !== intent.fromTaskIncarnationId ||
                envelope.source.principalId !== intent.senderPrincipalId ||
                envelope.source.deliveryId !== intent.deliveryId
            )
                return { kind: "not_admitted", reason: "invalid_payload_provenance" }

            const preflight = capacity(targetResult.lease.ingress.snapshot())
            if (preflight) return preflight
            const entryId = `cotask:${intent.deliveryId}`
            const targetPayloadRef = await targetResult.lease.payloads.put(payload)
            try {
                await targetResult.lease.ingress.accept({
                    entryId,
                    payloadRef: targetPayloadRef,
                    sourceTaskId: intent.fromTaskId,
                    dedupeKey: intent.dedupeKey,
                })
            } catch (error) {
                const racedCapacity = capacity(targetResult.lease.ingress.snapshot())
                if (racedCapacity) return racedCapacity
                const message = error instanceof Error ? error.message : String(error)
                return {
                    kind: "not_admitted",
                    reason: message.startsWith("CoTaskIngressFenced:") ? "target_fenced" : "target_ingress_rejected",
                }
            }
            this.dedupe.set(dedupeKey, { identity, entryId, payloadRef: targetPayloadRef })
            this.approvals.consume(intent)
            return { kind: "admitted", entryId, payloadRef: targetPayloadRef }
        } finally {
            targetResult.lease.release()
            sourceResult.lease.release()
        }
    }
}
