import { ProfileSwitchOperationRequest, ProfileSwitchResponse } from "@shared/proto/dline/state"
import { Controller } from ".."
import { toProfileSwitchResponse } from "./requestProfileSwitch"

/** Confirm the active Profile transition by immutable operation identity. */
export async function confirmProfileSwitch(
    controller: Controller,
    request: ProfileSwitchOperationRequest,
): Promise<ProfileSwitchResponse> {
    return toProfileSwitchResponse(await controller.confirmProfileSwitch(request.operationId))
}
