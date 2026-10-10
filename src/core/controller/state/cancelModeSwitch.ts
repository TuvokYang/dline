import { ModeSwitchOperationRequest, ModeSwitchResponse } from "@shared/proto/dline/state"
import { Controller } from ".."
import { toModeSwitchResponse } from "./togglePlanActModeProto"

/** Cancel the active mode-switch transaction by operation identity. */
export async function cancelModeSwitch(controller: Controller, request: ModeSwitchOperationRequest): Promise<ModeSwitchResponse> {
    return toModeSwitchResponse(await controller.cancelModeSwitch(request.operationId))
}
