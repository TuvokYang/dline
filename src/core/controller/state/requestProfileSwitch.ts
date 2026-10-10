import type { ProfileSwitchRequestResult, ProfileSwitchRequestStatus } from "@shared/profile-switch"
import { PlanActMode, ProfileSwitchRequest, ProfileSwitchResponse, ProfileSwitchStatus } from "@shared/proto/dline/state"
import type { Mode } from "@shared/storage/types"
import { Controller } from ".."

/** Map a domain Profile-switch status to its protobuf enum value. */
function toProtoStatus(status: ProfileSwitchRequestStatus): ProfileSwitchStatus {
    switch (status) {
        case "switched":
            return ProfileSwitchStatus.PROFILE_SWITCH_STATUS_SWITCHED
        case "confirmation_required":
            return ProfileSwitchStatus.PROFILE_SWITCH_STATUS_CONFIRMATION_REQUIRED
        case "in_progress":
            return ProfileSwitchStatus.PROFILE_SWITCH_STATUS_IN_PROGRESS
        case "rejected":
            return ProfileSwitchStatus.PROFILE_SWITCH_STATUS_REJECTED
    }
}

/** Convert a typed domain result into the public protobuf response. */
export function toProfileSwitchResponse(result: ProfileSwitchRequestResult): ProfileSwitchResponse {
    return ProfileSwitchResponse.create({
        status: toProtoStatus(result.status),
        operationId: result.operationId,
        error: result.error,
    })
}

/** Convert a protobuf mode list without accepting unspecified values. */
function fromProtoModes(modes: PlanActMode[]): Mode[] {
    return modes.map((mode) => {
        if (mode === PlanActMode.PLAN) return "plan"
        if (mode === PlanActMode.ACT) return "act"
        throw new Error(`Invalid Profile target mode value: ${mode}`)
    })
}

/** Request a confirmation-gated Profile transition for the active Task. */
export async function requestProfileSwitch(
    controller: Controller,
    request: ProfileSwitchRequest,
): Promise<ProfileSwitchResponse> {
    return toProfileSwitchResponse(
        await controller.requestProfileSwitch(request.targetProfile, fromProtoModes(request.targetModes), request.chatContent),
    )
}
