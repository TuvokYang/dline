import { randomUUID } from "node:crypto"
import type { ToolUse } from "@core/assistant-message"
import { ClineDefaultTool, getToolUseNames } from "@shared/tools"
import { isTurnEndingToolUse } from "../../../assistant-message-order"
import { type ProviderTurnApproval, resolveLaneContext, resolveToolLanes } from "../../../kernel"
import { approvalInteractionId } from "../../../tools/approval-interaction"
import type { ToolHandlerResult } from "../../../tools/ToolExecutionResult"
import { describeToolDenial, presentToolDenial, ToolExecutorCoordinator } from "../../../tools/ToolExecutorCoordinator"
import { ToolValidator } from "../../../tools/ToolValidator"
import type { TaskConfig } from "../../../tools/types/TaskConfig"
import type { ToolAdmissionSnapshot } from "../ToolAdmissionRegistry"

export interface ProductionToolPlan {
	readonly attempt: string
	readonly lanes: readonly string[]
	readonly turnEnding: boolean
	readonly approval: ProviderTurnApproval
}

/**
 * Project one admission's classification facts into the policy's fact map.
 *
 * Only defined facts are copied. The resolver distinguishes "absent" from
 * `false` for the tool-local gate, so writing a default would turn an
 * unconstrained call into an explicitly denied one.
 */
function riskFacts(
	block: ToolUse,
	admission: Extract<ReturnType<ToolExecutorCoordinator["prepareAdmission"]>, { outcome: "admitted" }>,
): Record<string, string | number | boolean> {
	const facts: Record<string, string | number | boolean> = { toolName: block.name }
	const scope = admission.scope
	if (scope?.isExternalPath !== undefined) facts.isExternalPath = scope.isExternalPath
	if (scope?.isSafeCommand !== undefined) facts.isSafeCommand = scope.isSafeCommand
	if (scope?.isToolAutoApproveEnabled !== undefined) facts.isToolAutoApproveEnabled = scope.isToolAutoApproveEnabled
	if (admission.inheritsApproval !== undefined) facts.inheritsApproval = admission.inheritsApproval
	return facts
}

function approval(block: ToolUse, result: ReturnType<ToolExecutorCoordinator["prepareAdmission"]>): ProviderTurnApproval {
	if (result.outcome === "rejected" || result.decision.kind === "none") return { kind: "none" }
	const interactionId = approvalInteractionId(block.dline_tid)
	if (result.decision.kind === "automatic" || result.decision.kind === "ai_approver") {
		return {
			kind: "automatic",
			interactionId,
			policyRevision: 0,
			// The policy re-resolves the decision from value facts alone, so it needs
			// the same inputs this admission used: the tool identity plus the facts
			// that classify the call. Sending the resolved scope instead would send
			// an output as an input, and the policy would reclassify the call from an
			// empty context: a safe command would be judged as an arbitrary one and
			// refused under a grant that does cover it.
			riskFacts: riskFacts(block, result),
		}
	}
	return {
		kind: "manual",
		interactionId,
		presentationRef: result.presentation?.body ?? JSON.stringify(block.params),
		// The body format depends on the ask (a command line is plain text, a tool
		// row is JSON), so the anchor must be written with the same ask that built it.
		...(result.presentation?.ask === undefined ? {} : { presentationAsk: result.presentation.ask }),
		actionRules: [
			// Approving with a note is a normal workflow ("approve, but read it this
			// way"), so approve carries the composer draft exactly like reject does.
			// Declaring it as `none` made the surface drop what the user typed.
			{ actionId: "approve", payloadPolicy: "draft" },
			{ actionId: "reject", payloadPolicy: "draft" },
		],
	}
}

/** Shared task-scoped handler registry used by provider planning and tool execution. */
export class ProductionToolHandlerRuntime {
	readonly coordinator = new ToolExecutorCoordinator()

	constructor(validator: ToolValidator) {
		for (const toolName of getToolUseNames()) this.coordinator.registerByName(toolName as ClineDefaultTool, validator)
	}

	async plan(block: ToolUse, snapshot: ToolAdmissionSnapshot): Promise<ProductionToolPlan> {
		const initial = this.coordinator.prepareAdmission(block, snapshot, async () => undefined)
		const preflight = initial.outcome === "admitted" && initial.confirm ? await initial.confirm() : initial
		return {
			attempt: randomUUID(),
			lanes: preflight.outcome === "admitted" ? preflight.lanes : resolveToolLanes(block.name, resolveLaneContext(block)),
			turnEnding: isTurnEndingToolUse(block),
			approval: approval(block, preflight),
		}
	}

	execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
		return this.coordinator.execute(config, block)
	}

	presentDenial(config: TaskConfig, block: ToolUse): Promise<void> {
		return presentToolDenial(this.coordinator.getHandler(block.name), config, block)
	}

	/** The result a refused call reports to the model, in its handler's own words. */
	describeDenial(config: TaskConfig, block: ToolUse): Promise<string> {
		return describeToolDenial(this.coordinator.getHandler(block.name), config, block)
	}

	restoreSubagentRetry(config: TaskConfig, activityId: string): Promise<boolean> {
		return this.coordinator.restoreSubagentRetry(config, activityId)
	}
}
