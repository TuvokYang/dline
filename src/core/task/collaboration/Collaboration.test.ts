import { describe, expect, it } from "vitest"
import { InMemoryCoTaskApprovalLedger } from "./CoTaskApprovalLedger"
import type { AttestedDeliveryIntent } from "./CoTaskDeliveryGateway"
import { createTaskDirectoryRegistry, type TaskIncarnationId } from "./TaskDirectory"

const incarnation = (value: string) => value as TaskIncarnationId

describe("task collaboration contracts", () => {
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

	it("binds an approval to the complete principal, source, target and payload scope", async () => {
		const ledger = new InMemoryCoTaskApprovalLedger()
		const scope: Omit<AttestedDeliveryIntent, "approvalRef"> = {
			deliveryId: "delivery-1",
			fromTaskId: "source",
			fromTaskIncarnationId: incarnation("source-inc"),
			toTaskId: "target",
			toTaskIncarnationId: incarnation("target-inc"),
			targetRegistrationGeneration: 1 as never,
			senderPrincipalId: "task:source:source-inc",
			payloadRef: "sha256:payload",
			payloadHash: "payload-hash",
			dedupeKey: "message-1",
		}
		const grant = ledger.issue(scope)
		const intent = { ...scope, approvalRef: grant.approvalRef }

		expect(await ledger.verify(intent)).toEqual({ kind: "verified", principalId: scope.senderPrincipalId })
		expect(await ledger.verify({ ...intent, payloadHash: "tampered" })).toEqual({ kind: "invalid" })
		ledger.consume(intent)
		expect(await ledger.verify(intent)).toEqual({ kind: "verified", principalId: scope.senderPrincipalId })
	})
})
