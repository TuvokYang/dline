import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { CoTaskDeliveryGateway, InMemoryTargetPayloadStore } from "./CoTaskDeliveryGateway"
import {
	type CoTaskIngressEntry,
	createTaskDirectoryRegistry,
	type RegistrationGeneration,
	type TaskIncarnationId,
} from "./TaskDirectory"

const incarnation = (value: string) => value as TaskIncarnationId

function sha256(payload: Uint8Array): string {
	return createHash("sha256").update(payload).digest("hex")
}

describe("task collaboration", () => {
	it("keeps directory projection read-only and fences stale status updates", () => {
		const registry = createTaskDirectoryRegistry()
		const ingress = { snapshot: () => ({ closing: false, pending: 0, limit: 4 }), accept: async () => undefined }
		const registration = registry.registrar.register({
			taskId: "task-1",
			taskIncarnationId: incarnation("inc-1"),
			createdAt: "2026-09-19T00:00:00Z",
			kind: "main",
			initialStatus: {
				taskIncarnationId: incarnation("inc-1"),
				statusRevision: 1,
				summary: "task",
				phase: "running",
				activeWriteIntents: [],
			},
			ingress,
		})
		const projection = registry.directory.find("task-1") as unknown as Record<string, unknown>
		expect(projection).not.toHaveProperty("ingress")
		expect(
			registration.publishStatus({
				taskIncarnationId: incarnation("inc-1"),
				registrationGeneration: registration.descriptor.registrationGeneration,
				statusRevision: 1,
				summary: "stale",
				phase: "paused",
				activeWriteIntents: [],
			}),
		).toBe(false)
	})

	it("copies payload ownership, deduplicates retries and rejects capacity without target mutation", async () => {
		const registry = createTaskDirectoryRegistry()
		const entries: CoTaskIngressEntry[] = []
		let pending = 0
		const registration = registry.registrar.register({
			taskId: "target",
			taskIncarnationId: incarnation("target-inc"),
			createdAt: "2026-09-19T00:00:00Z",
			kind: "main",
			initialStatus: {
				taskIncarnationId: incarnation("target-inc"),
				statusRevision: 1,
				summary: "target",
				phase: "running",
				activeWriteIntents: [],
			},
			ingress: {
				snapshot: () => ({ closing: false, pending, limit: 1 }),
				accept: async (entry) => {
					entries.push(entry)
					pending++
				},
			},
		})
		const sourcePayloads = new Map<string, Uint8Array>([["sender:payload", new TextEncoder().encode("hello")]])
		const targetPayloads = new InMemoryTargetPayloadStore()
		const gateway = new CoTaskDeliveryGateway(
			registry.ingressResolver,
			{ verify: async () => ({ kind: "verified", principalId: "principal-1" }) },
			{
				read: async (payloadRef) => {
					const payload = sourcePayloads.get(payloadRef)
					if (!payload) throw new Error("source missing")
					return payload
				},
			},
			targetPayloads,
		)
		const intent = {
			deliveryId: "delivery-1",
			fromTaskId: "sender",
			fromTaskIncarnationId: incarnation("sender-inc"),
			toTaskId: "target",
			toTaskIncarnationId: incarnation("target-inc"),
			targetRegistrationGeneration: registration.descriptor.registrationGeneration as RegistrationGeneration,
			senderPrincipalId: "principal-1",
			approvalRef: "approval-1",
			payloadRef: "sender:payload",
			payloadHash: sha256(sourcePayloads.get("sender:payload")!),
			dedupeKey: "same-message",
		}
		const admitted = await gateway.deliver(intent)
		expect(admitted.kind).toBe("admitted")
		sourcePayloads.delete("sender:payload")
		if (admitted.kind === "admitted")
			expect(new TextDecoder().decode(await targetPayloads.read(admitted.payloadRef))).toBe("hello")
		expect(await gateway.deliver(intent)).toMatchObject({ kind: "duplicate", entryId: "cotask:delivery-1" })

		sourcePayloads.set("sender:payload-2", new TextEncoder().encode("second"))
		const before = [...entries]
		const capacity = await gateway.deliver({
			...intent,
			deliveryId: "delivery-2",
			dedupeKey: "second-message",
			payloadRef: "sender:payload-2",
			payloadHash: sha256(sourcePayloads.get("sender:payload-2")!),
		})
		expect(capacity).toEqual({ kind: "target_capacity_exceeded", pending: 1, limit: 1 })
		expect(entries).toEqual(before)
	})
})
