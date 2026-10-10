import type { ModeSwitchRequestResult, ModeSwitchRequestStatus } from "@shared/mode-switch"
import { ModeSwitchResponse, ModeSwitchStatus, PlanActMode, TogglePlanActModeRequest } from "@shared/proto/dline/state"
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
        const result = await controller.requestModeSwitch(mode, request.chatContent)
        return toModeSwitchResponse(result)
    } catch (error) {
        Logger.error("Failed to toggle Plan/Act mode:", error)
        throw error
    }
}
