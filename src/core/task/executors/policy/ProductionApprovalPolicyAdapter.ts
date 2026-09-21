import {
	type AutoApprovalSettingsLike,
	type ConfigurableCeilings,
	type PermissionScopeContext,
	resolveApprovalKind,
} from "../../kernel"
import type { ApprovalPolicyInput, ApprovalPolicyPort, ApprovalPolicyResult } from "./PolicyCommandExecutor"

export interface ApprovalPolicySnapshot {
	readonly settings: AutoApprovalSettingsLike
	readonly ceilings?: ConfigurableCeilings
	readonly blanket?: { readonly yoloMode?: boolean; readonly approveAll?: boolean }
}

export interface ProductionApprovalPolicyAdapterOptions {
	readonly readSnapshot: () => ApprovalPolicySnapshot | Promise<ApprovalPolicySnapshot>
}

function booleanFact(facts: ApprovalPolicyInput["riskFacts"], key: string): boolean | undefined {
	const value = facts[key]
	return typeof value === "boolean" ? value : undefined
}

/** Evaluates value-only risk facts against one immutable approval-settings snapshot. */
export class ProductionApprovalPolicyAdapter implements ApprovalPolicyPort {
	constructor(private readonly options: ProductionApprovalPolicyAdapterOptions) {}

	async evaluate(input: ApprovalPolicyInput): Promise<ApprovalPolicyResult> {
		if (input.signal.aborted) throw input.signal.reason
		const toolName = input.riskFacts.toolName
		if (typeof toolName !== "string" || toolName.length === 0) throw new Error("MissingPolicyToolName")
		const snapshot = await this.options.readSnapshot()
		if (input.signal.aborted) throw input.signal.reason
		const context: PermissionScopeContext = {
			isExternalPath: booleanFact(input.riskFacts, "isExternalPath"),
			isSafeCommand: booleanFact(input.riskFacts, "isSafeCommand"),
			isToolAutoApproveEnabled: booleanFact(input.riskFacts, "isToolAutoApproveEnabled"),
		}
		const decision = resolveApprovalKind({
			toolName,
			settings: snapshot.settings,
			ceilings: snapshot.ceilings,
			blanket: snapshot.blanket,
			context,
			inheritsApproval: booleanFact(input.riskFacts, "inheritsApproval"),
		})
		return { approved: decision.kind === "none" || decision.kind === "automatic" }
	}
}
