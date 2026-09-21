import { randomUUID } from "node:crypto"
import type { ToolUse } from "@core/assistant-message"
import { ClineDefaultTool, getToolUseNames } from "@shared/tools"
import { isTurnEndingToolUse } from "../../../assistant-message-order"
import type { ProviderTurnApproval } from "../../../kernel"
import { resolveLaneContext, resolveToolLanes } from "../../../kernel/turn/tool-lanes"
import type { ToolHandlerResult } from "../../../tools/ToolExecutionResult"
import { ToolExecutorCoordinator } from "../../../tools/ToolExecutorCoordinator"
import { ToolValidator } from "../../../tools/ToolValidator"
import type { TaskConfig } from "../../../tools/types/TaskConfig"
import type { ToolAdmissionSnapshot } from "../ToolAdmissionRegistry"

export interface ProductionToolPlan {
	readonly attempt: string
	readonly lanes: readonly string[]
	readonly turnEnding: boolean
	readonly approval: ProviderTurnApproval
}

function approval(block: ToolUse, result: ReturnType<ToolExecutorCoordinator["prepareAdmission"]>): ProviderTurnApproval {
	if (result.outcome === "rejected" || result.decision.kind === "none") return { kind: "none" }
	const interactionId = `approval:${block.dline_tid}`
	if (result.decision.kind === "automatic" || result.decision.kind === "ai_approver") {
		return {
			kind: "automatic",
			interactionId,
			policyRevision: 0,
			riskFacts: { scope: result.decision.scope, ceiling: result.decision.ceiling },
		}
	}
	return {
		kind: "manual",
		interactionId,
		presentationRef: result.presentation?.body ?? JSON.stringify(block.params),
		actionRules: [
			{ actionId: "approve", payloadPolicy: "none" },
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

	plan(block: ToolUse, snapshot: ToolAdmissionSnapshot): ProductionToolPlan {
		const preflight = this.coordinator.prepareAdmission(block, snapshot, async () => undefined)
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

	restoreSubagentRetry(config: TaskConfig, activityId: string): Promise<boolean> {
		return this.coordinator.restoreSubagentRetry(config, activityId)
	}
}
