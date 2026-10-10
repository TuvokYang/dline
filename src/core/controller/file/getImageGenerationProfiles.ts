import { EmptyRequest } from "@shared/proto/dline/common"
import { ImageGenerationProfilesResponse } from "@shared/proto/dline/profile"
import type { Controller } from ".."
import { projectImageGenerationProfilesForUi, readImageGenerationProfiles } from "./imageGenerationProfiles"

export async function getImageGenerationProfiles(
    _controller: Controller,
    _request: EmptyRequest,
): Promise<ImageGenerationProfilesResponse> {
    return ImageGenerationProfilesResponse.create({
        profiles: projectImageGenerationProfilesForUi(readImageGenerationProfiles()),
    })
}
