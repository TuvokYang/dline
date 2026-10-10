import { ProfileSwitchOperationRequest, ProfileSwitchResponse } from "@shared/proto/dline/state"
import { Controller } from ".."
import { toProfileSwitchResponse } from "./requestProfileSwitch"

/** Cancel the active Profile confirmation without adopting target settings. */
export async function cancelProfileSwitch(
    controller: Controller,
    request: ProfileSwitchOperationRequest,
): Promise<ProfileSwitchResponse> {
    return toProfileSwitchResponse(await controller.cancelProfileSwitch(request.operationId))
}
