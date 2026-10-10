import { Empty } from "@shared/proto/dline/common"
import type { UpdateImageGenerationProfilesRequest } from "@shared/proto/dline/profile"
import type { Controller } from ".."
import { updateImageGenerationProfileCatalog } from "./imageGenerationProfiles"

export async function updateImageGenerationProfiles(
    controller: Controller,
    request: UpdateImageGenerationProfilesRequest,
): Promise<Empty> {
    await updateImageGenerationProfileCatalog(request)
    await controller.postStateToWebview?.()
    return Empty.create({})
}
