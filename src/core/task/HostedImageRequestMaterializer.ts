import type { ApiRequestOptions } from "@core/api"
import { DEFAULT_IMAGE_GENERATION_SIZE } from "@core/image-generation/ImageGenerationSizes"
import { ServerTool } from "@shared/proto/dline/models/metadata"

/**
 * Freezes legacy request-scoped hosted image options without reading composer state.
 * New image generation flows through the ordinary generate_image tool and its adapter.
 */
export class HostedImageRequestMaterializer {
    private readonly optionsByRequestScope = new WeakMap<object, Promise<ApiRequestOptions["imageGeneration"]>>()

    materialize(
        requestScope: object,
        serverTools: readonly ServerTool[],
        overrides: Omit<NonNullable<ApiRequestOptions["imageGeneration"]>, "references"> = {},
    ): Promise<ApiRequestOptions["imageGeneration"]> {
        if (!serverTools.includes(ServerTool.IMAGE_GENERATION)) return Promise.resolve(undefined)
        const existing = this.optionsByRequestScope.get(requestScope)
        if (existing) return existing

        const materialized = Promise.resolve({
            references: [],
            partialImages: overrides.partialImages ?? 3,
            size: overrides.size ?? DEFAULT_IMAGE_GENERATION_SIZE,
        })
        this.optionsByRequestScope.set(requestScope, materialized)
        return materialized
    }
}
