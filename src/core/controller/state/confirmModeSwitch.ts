import { ModeSwitchOperationRequest, ModeSwitchResponse } from "@shared/proto/dline/state"
import { Controller } from ".."
import { toModeSwitchResponse } from "./togglePlanActModeProto"

/** Confirm the active mode-switch transaction by operation identity. */
export async function confirmModeSwitch(
    controller: Controller,
    request: ModeSwitchOperationRequest,
): Promise<ModeSwitchResponse> {
    return toModeSwitchResponse(await controller.confirmModeSwitch(request.operationId))
}
