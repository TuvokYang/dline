import type { CoTaskIngressExecutor } from "../executors/cotask/CoTaskIngressExecutor"
import type { TaskState } from "../kernel"
import { INTAKE_BOX_LIMIT } from "../kernel/machines/intake"
import type { TaskPayloadStore } from "../stores"
import { InMemoryCoTaskApprovalLedger } from "./CoTaskApprovalLedger"
import {
	type AttestedDeliveryIntent,
	type CoTaskDeliveryAuthorizationRequest,
	CoTaskDeliveryGateway,
	type CoTaskSessionLeaseResolver,
	type DeliveryAdmission,
	type DeliveryAuthorization,
} from "./CoTaskDeliveryGateway"
import {
	type CoTaskIngressEntry,
	createTaskDirectoryRegistry,
	type RegistrationGeneration,
	type TaskDescriptor,
	type TaskDirectory,
	type TaskIncarnationId,
	type TaskRegistration,
	type TaskStatusProjection,
} from "./TaskDirectory"

export interface TaskCollaborationRegistrationInput {
	readonly taskId: string
	readonly taskIncarnationId: string
	readonly createdAt: string
	readonly kind: TaskDescriptor["kind"]
	readonly summary: string
	readonly state: () => Readonly<TaskState>
	readonly ingress: CoTaskIngressExecutor
	readonly payloads: TaskPayloadStore
}

export interface TaskCollaborationLease {
	readonly descriptor: TaskDescriptor
	publishCommitted(state: Readonly<TaskState>): boolean
	beginClose(): void
	release(): Promise<void>
}

interface ActiveSession {
	readonly registration: TaskRegistration
	readonly input: TaskCollaborationRegistrationInput
	closing: boolean
	leaseCount: number
	releasePromise?: Promise<void>
	resolveDrained?: () => void
}

/** Process-scoped owner of writable task routes, payload leases and authorized CoTask delivery. */
export class TaskCollaborationRuntime {
	private readonly registry = createTaskDirectoryRegistry()
	private readonly sessions = new Map<string, ActiveSession>()
	private readonly gateway: CoTaskDeliveryGateway

	constructor() {
		const resolver: CoTaskSessionLeaseResolver = { acquire: (input) => this.acquire(input) }
		this.gateway = new CoTaskDeliveryGateway(resolver, new InMemoryCoTaskApprovalLedger())
	}

	get directory(): TaskDirectory {
		return this.registry.directory
	}

	authorizeDelivery(request: CoTaskDeliveryAuthorizationRequest): Promise<DeliveryAuthorization> {
		return this.gateway.authorize(request)
	}

	deliver(intent: AttestedDeliveryIntent): Promise<DeliveryAdmission> {
		return this.gateway.deliver(intent)
	}

	register(input: TaskCollaborationRegistrationInput): TaskCollaborationLease {
		const taskIncarnationId = input.taskIncarnationId as TaskIncarnationId
		let active: ActiveSession | undefined
		const registration = this.registry.registrar.register({
			taskId: input.taskId,
			taskIncarnationId,
			createdAt: input.createdAt,
			kind: input.kind,
			initialStatus: this.status(input, input.state(), 0 as RegistrationGeneration),
			ingress: {
				snapshot: () => this.ingressSnapshot(active),
				accept: (entry) => this.accept(active, entry, false),
			},
		})
		active = { registration, input, closing: false, leaseCount: 0 }
		this.sessions.set(input.taskId, active)
		return {
			descriptor: registration.descriptor,
			publishCommitted: (state) =>
				registration.publishStatus(this.status(input, state, registration.descriptor.registrationGeneration)),
			beginClose: () => {
				if (this.sessions.get(input.taskId) === active) active!.closing = true
			},
			release: () => this.release(active!),
		}
	}

	private acquire(
		input: Parameters<CoTaskSessionLeaseResolver["acquire"]>[0],
	): ReturnType<CoTaskSessionLeaseResolver["acquire"]> {
		const active = this.sessions.get(input.taskId)
		if (!active) return { kind: "absent" }
		if (
			(input.expectedTaskIncarnationId !== undefined &&
				active.registration.descriptor.taskIncarnationId !== input.expectedTaskIncarnationId) ||
			(input.expectedRegistrationGeneration !== undefined &&
				active.registration.descriptor.registrationGeneration !== input.expectedRegistrationGeneration)
		)
			return { kind: "stale" }
		if (active.closing) return { kind: "closing" }
		active.leaseCount++
		let released = false
		return {
			kind: "acquired",
			lease: {
				descriptor: active.registration.descriptor,
				payloads: active.input.payloads,
				ingress: {
					snapshot: () => ({ ...this.ingressSnapshot(active), closing: false }),
					accept: (entry) => this.accept(active, entry, true),
				},
				release: () => {
					if (released) return
					released = true
					active.leaseCount--
					if (active.leaseCount === 0) active.resolveDrained?.()
				},
			},
		}
	}

	private ingressSnapshot(active: ActiveSession | undefined) {
		if (!active) return { closing: true, pending: 0, limit: INTAKE_BOX_LIMIT }
		return {
			closing: active.closing,
			pending: active.input.state().intake.coTask.filter((entry) => entry.state !== "consumed").length,
			limit: INTAKE_BOX_LIMIT,
		}
	}

	private async accept(active: ActiveSession | undefined, entry: CoTaskIngressEntry, allowClosing: boolean): Promise<void> {
		if (!active) throw new Error("CoTaskTargetAbsent")
		if (active.closing && !allowClosing) throw new Error("CoTaskTargetClosing")
		const result = await active.input.ingress.publish({
			entryId: entry.entryId as never,
			payloadRef: entry.payloadRef,
		})
		if (result.kind === "accepted") {
			await result.durable
			return
		}
		if (result.kind === "fenced") throw new Error(`CoTaskIngressFenced:${result.haltId}`)
		const existing = active.input.state().intake.coTask.find((candidate) => candidate.entryId === entry.entryId)
		if (existing?.payloadRef === entry.payloadRef) return
		throw new Error("CoTaskIngressRejected")
	}

	private release(active: ActiveSession): Promise<void> {
		if (active.releasePromise) return active.releasePromise
		active.closing = true
		active.registration.dispose()
		active.releasePromise = (async () => {
			if (active.leaseCount > 0) {
				await new Promise<void>((resolve) => {
					active.resolveDrained = resolve
				})
			}
			active.resolveDrained = undefined
			if (this.sessions.get(active.input.taskId) === active) this.sessions.delete(active.input.taskId)
		})()
		return active.releasePromise
	}

	private status(
		input: TaskCollaborationRegistrationInput,
		state: Readonly<TaskState>,
		registrationGeneration: TaskStatusProjection["registrationGeneration"],
	): TaskStatusProjection {
		return {
			taskIncarnationId: input.taskIncarnationId as TaskIncarnationId,
			registrationGeneration,
			statusRevision: state.revision,
			summary: input.summary,
			phase: state.flow.phase,
			activeWriteIntents: [],
		}
	}
}
