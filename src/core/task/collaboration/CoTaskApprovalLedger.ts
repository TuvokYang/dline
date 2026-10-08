import { randomUUID } from "node:crypto"
import { stableJsonStringify } from "@shared/stable-json"
import type { AttestedDeliveryIntent } from "./CoTaskDeliveryGateway"

export interface CoTaskApprovalGrant {
	readonly approvalRef: string
	readonly principalId: string
}

export interface CoTaskApprovalScope extends Omit<AttestedDeliveryIntent, "approvalRef"> {}

export type CoTaskApprovalVerification =
	| { readonly kind: "verified"; readonly principalId: string }
	| { readonly kind: "stale" }
	| { readonly kind: "invalid" }
	| { readonly kind: "not_admitted" }

export interface CoTaskApprovalLedger {
	issue(scope: CoTaskApprovalScope): CoTaskApprovalGrant
	verify(intent: AttestedDeliveryIntent): Promise<CoTaskApprovalVerification>
	consume(intent: AttestedDeliveryIntent): void
}

interface ApprovalRecord {
	readonly fingerprint: string
	readonly principalId: string
	state: "issued" | "consumed"
}

function fingerprint(scope: CoTaskApprovalScope): string {
	return stableJsonStringify(scope)
}

/** Process-scoped approval ledger bound to the exact live source and target incarnations. */
export class InMemoryCoTaskApprovalLedger implements CoTaskApprovalLedger {
	private readonly records = new Map<string, ApprovalRecord>()

	issue(scope: CoTaskApprovalScope): CoTaskApprovalGrant {
		const approvalRef = `cotask-approval:${randomUUID()}`
		this.records.set(approvalRef, {
			fingerprint: fingerprint(scope),
			principalId: scope.senderPrincipalId,
			state: "issued",
		})
		return { approvalRef, principalId: scope.senderPrincipalId }
	}

	async verify(intent: AttestedDeliveryIntent): Promise<CoTaskApprovalVerification> {
		const record = this.records.get(intent.approvalRef)
		if (!record) return { kind: "invalid" }
		const { approvalRef: _approvalRef, ...scope } = intent
		if (record.fingerprint !== fingerprint(scope)) return { kind: "invalid" }
		return { kind: "verified", principalId: record.principalId }
	}

	consume(intent: AttestedDeliveryIntent): void {
		const record = this.records.get(intent.approvalRef)
		if (!record) throw new Error(`CoTaskApprovalMissing:${intent.approvalRef}`)
		const { approvalRef: _approvalRef, ...scope } = intent
		if (record.fingerprint !== fingerprint(scope)) throw new Error(`CoTaskApprovalConflict:${intent.approvalRef}`)
		record.state = "consumed"
	}
}
