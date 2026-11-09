import { randomUUID } from "node:crypto"
import type { ToolUse } from "@core/assistant-message"
import { isTurnEndingToolUse } from "../../../assistant-message-order"
import { getInteraction, specializedToolApprovalKind } from "../../../interaction/InteractionRegistry"
import {
    type DialogActionRule,
    type ProviderTurnApproval,
    type ProviderTurnBlockPlan,
    resolveLaneContext,
    resolveToolLanes,
} from "../../../kernel"
import { approvalInteractionId } from "../../../tools/approval-interaction"
import type { ToolExecutorCoordinator } from "../../../tools/ToolExecutorCoordinator"
import type { ToolAdmissionSnapshot } from "../ToolAdmissionRegistry"
import { isAwayFeedbackTool } from "./AwayToolPolicy"

/** The block plan fields a tool decides before admission, named on the kernel contract both executors share. */
type PlannedTool = Pick<ProviderTurnBlockPlan, "attempt" | "lanes" | "turnEnding" | "approval" | "disposition">

function riskFacts(
    block: ToolUse,
    admission: Extract<ReturnType<ToolExecutorCoordinator["prepareAdmission"]>, { outcome: "admitted" }>,
): Record<string, string | number | boolean> {
    const facts: Record<string, string | number | boolean> = { toolName: block.name }
    const scope = admission.scope
    if (scope?.isExternalPath !== undefined) facts.isExternalPath = scope.isExternalPath
    if (scope?.awayCommand !== undefined) facts.awayCommand = scope.awayCommand
    if (scope?.isSafeCommand !== undefined) facts.isSafeCommand = scope.isSafeCommand
    if (scope?.isToolAutoApproveEnabled !== undefined) facts.isToolAutoApproveEnabled = scope.isToolAutoApproveEnabled
    if (admission.inheritsApproval !== undefined) facts.inheritsApproval = admission.inheritsApproval
    return facts
}

const GENERIC_APPROVAL_RULES: readonly DialogActionRule[] = [
    { actionId: "approve", payloadPolicy: "draft" },
    { actionId: "reject", payloadPolicy: "draft" },
]

/**
 * Action rules of a manual approval. A specialized approval such as NEW_TASK
 * takes its rules from its own interaction definition, so Start New Task
 * carries no payload and leaves the unsent draft for the successor.
 */
function approvalActionRules(ask: string | undefined): readonly DialogActionRule[] {
    const specialized = specializedToolApprovalKind(ask)
    if (!specialized) return GENERIC_APPROVAL_RULES
    return getInteraction(specialized).actions.map((action) => ({ actionId: action.type, payloadPolicy: action.payloadPolicy }))
}

function approval(
    block: ToolUse,
    result: ReturnType<ToolExecutorCoordinator["prepareAdmission"]>,
    aiApproverAvailable: boolean,
    ownsInteractionConfirmation: boolean,
): ProviderTurnApproval {
    if (result.outcome === "rejected" || ownsInteractionConfirmation) return { kind: "none" }
    if (result.decision.kind === "none")
        return { kind: "none", ...(result.scope?.awayCommand === "workspace" ? { awayCommand: true as const } : {}) }
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
        ...(result.presentation?.commandWorkingDirectory === undefined
            ? {}
            : { presentationWorkingDirectory: result.presentation.commandWorkingDirectory }),
        actionRules: approvalActionRules(result.presentation?.ask),
        ...(result.scope?.awayCommand === "external" ? { externalCommand: true as const } : {}),
    }
}

/** Plan one tool from value-only admission facts without canonical target I/O. */
export function planProductionTool(
    coordinator: ToolExecutorCoordinator,
    block: ToolUse,
    snapshot: ToolAdmissionSnapshot,
    options: { readonly aiApproverAvailable?: boolean } = {},
): PlannedTool {
    if (snapshot.awayActive && isAwayFeedbackTool(block.name))
        return {
            attempt: randomUUID(),
            lanes: [],
            turnEnding: true,
            approval: { kind: "none" },
            disposition: "away_feedback_only",
        }
    const preflight = coordinator.prepareAdmission(block, snapshot, async () => undefined)
    return {
        attempt: randomUUID(),
        lanes: preflight.outcome === "admitted" ? preflight.lanes : resolveToolLanes(block.name, resolveLaneContext(block)),
        turnEnding: isTurnEndingToolUse(block),
        approval: approval(
            block,
            preflight,
            options.aiApproverAvailable === true,
            coordinator.ownsInteractionConfirmation(block.name),
        ),
    }
}
