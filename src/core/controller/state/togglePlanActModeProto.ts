import type { SemanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import type { ModeSwitchRequestResult, ModeSwitchRequestStatus } from "@shared/mode-switch"
import { ModeSwitchResponse, ModeSwitchStatus, PlanActMode, TogglePlanActModeRequest } from "@shared/proto/dline/state"
import { fromProtoChatContent } from "@shared/proto-conversions/input-semantics/chat-content"
import { toProtoSemanticInputDiagnostic } from "@shared/proto-conversions/input-semantics/diagnostic"
import type { Mode } from "@shared/storage/types"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/** Map a domain mode-switch status to its protobuf enum value. */
function toProtoStatus(status: ModeSwitchRequestStatus): ModeSwitchStatus {
    switch (status) {
        case "switched":
            return ModeSwitchStatus.MODE_SWITCH_STATUS_SWITCHED
        case "confirmation_required":
            return ModeSwitchStatus.MODE_SWITCH_STATUS_CONFIRMATION_REQUIRED
        case "in_progress":
            return ModeSwitchStatus.MODE_SWITCH_STATUS_IN_PROGRESS
        case "rejected":
            return ModeSwitchStatus.MODE_SWITCH_STATUS_REJECTED
    }
}

/** Convert a typed domain result into the public protobuf response. */
export function toModeSwitchResponse(result: ModeSwitchRequestResult): ModeSwitchResponse {
    return ModeSwitchResponse.create({
        status: toProtoStatus(result.status),
        operationId: result.operationId,
        error: result.error,
        draftDelivered: result.draftDelivered,
    })
}

/** Refuse the switch and locate the draft problem, so the Webview keeps the draft editable and marks the node. */
function rejectDraft(diagnostic: SemanticInputDiagnostic): ModeSwitchResponse {
    return ModeSwitchResponse.create({
        ...toModeSwitchResponse({ status: "rejected", error: diagnostic.message }),
        diagnostic: toProtoSemanticInputDiagnostic(diagnostic),
    })
}

/** Request a task-local Plan/Act mode-switch transaction. */
export async function togglePlanActModeProto(
    controller: Controller,
    request: TogglePlanActModeRequest,
): Promise<ModeSwitchResponse> {
    try {
        let mode: Mode
        if (request.mode === PlanActMode.PLAN) {
            mode = "plan"
        } else if (request.mode === PlanActMode.ACT) {
            mode = "act"
        } else {
            throw new Error(`Invalid mode value: ${request.mode}`)
        }
        const draft = fromProtoChatContent(request.chatContent)
        if (!draft.ok) return rejectDraft(draft.diagnostic)
        const result = await controller.requestModeSwitch(mode, draft.content)
        return toModeSwitchResponse(result)
    } catch (error) {
        Logger.error("Failed to toggle Plan/Act mode:", error)
        throw error
    }
}
