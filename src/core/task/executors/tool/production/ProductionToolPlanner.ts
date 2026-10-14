import { randomUUID } from "node:crypto"
import type { ToolUse } from "@core/assistant-message"
import { isTurnEndingToolUse } from "../../../assistant-message-order"
import { type ProviderTurnApproval, resolveLaneContext, resolveToolLanes } from "../../../kernel"
import { approvalInteractionId } from "../../../tools/approval-interaction"
import type { ToolExecutorCoordinator } from "../../../tools/ToolExecutorCoordinator"
import type { PlannedProviderTool } from "../../provider/service/ProviderRequest"
import type { ToolAdmissionSnapshot } from "../ToolAdmissionRegistry"

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

function approval(
    block: ToolUse,
    result: ReturnType<ToolExecutorCoordinator["prepareAdmission"]>,
    aiApproverAvailable: boolean,
): ProviderTurnApproval {
    if (result.outcome === "rejected" || result.decision.kind === "none") return { kind: "none" }
    const interactionId = approvalInteractionId(block.dline_tid)
    if (result.decision.kind === "automatic" || (result.decision.kind === "ai_approver" && aiApproverAvailable)) {
        return {
            kind: "automatic",
            interactionId,
            policyRevision: 0,
            riskFacts: riskFacts(block, result),
        }
    }
    return {
        kind: "manual",
        interactionId,
        presentationRef: result.presentation?.body ?? JSON.stringify(block.params),
        ...(result.presentation?.ask === undefined ? {} : { presentationAsk: result.presentation.ask }),
        ...(typeof block.ts === "number" ? { presentationRow: block.ts } : {}),
        actionRules: [
            { actionId: "approve", payloadPolicy: "draft" },
            { actionId: "reject", payloadPolicy: "draft" },
        ],
    }
}

/** Plan one tool from value-only admission facts without canonical target I/O. */
export function planProductionTool(
    coordinator: ToolExecutorCoordinator,
    block: ToolUse,
    snapshot: ToolAdmissionSnapshot,
    options: { readonly aiApproverAvailable?: boolean } = {},
): PlannedProviderTool {
    const preflight = coordinator.prepareAdmission(block, snapshot, async () => undefined)
    return {
        attempt: randomUUID(),
        lanes: preflight.outcome === "admitted" ? preflight.lanes : resolveToolLanes(block.name, resolveLaneContext(block)),
        turnEnding: isTurnEndingToolUse(block),
        approval: approval(block, preflight, options.aiApproverAvailable === true),
    }
}
