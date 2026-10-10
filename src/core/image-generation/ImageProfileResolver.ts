import { resolveProfileReference } from "@core/profiles/profile-binding"
import { GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID } from "@shared/image-generation"
import type { ImageModelInfo } from "@shared/proto/dline/models"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile, type ImageGenerationProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import { openAiEndpointToApiFormat, resolveApiFormat } from "@shared/providers/api-format"
import { ImageGenerationError } from "./contracts"

export const OPENAI_HOSTED_IMAGE_ADAPTER_ID = "openai:hosted"

export interface ResolvedImageProfile {
    profile: ApiProfile
    model: ImageModelInfo
    source: ImageGenerationSource
    adapterId: string
}

export interface ImageProfileResolverOptions {
    readApiProfiles?: () => ApiProfile[]
    readProfiles?: () => ApiProfile[]
    readImageProfiles?: () => ImageGenerationProfile[]
    getDefaultProfileId?: () => string | undefined
    getDefaultProfileName?: () => string | undefined
    getCurrentProfileId: () => string | undefined
    getCurrentProfileName: () => string | undefined
    getImageModel: (providerId: string, modelId: string) => ImageModelInfo | undefined
    getDefaultImageModelId: (providerId: string) => string | undefined
}

function unavailable(message: string): never {
    throw new ImageGenerationError({ code: "invalid_request", message, retryable: false })
}

export class ImageProfileResolver {
    constructor(private readonly options: ImageProfileResolverOptions) {}

    hasAvailableProfile(): boolean {
        return this.resolveAvailable() !== undefined
    }

    /** Resolves the bound image profile, returning undefined instead of throwing when none is available. */
    resolveAvailable(selector?: string): ResolvedImageProfile | undefined {
        try {
            return this.resolve(selector)
        } catch {
            return undefined
        }
    }

    resolve(selector?: string): ResolvedImageProfile {
        const apiProfiles = (this.options.readApiProfiles ?? this.options.readProfiles)?.() ?? []
        const reference = this.options.getCurrentProfileId() ?? this.options.getCurrentProfileName()
        if (!reference) return unavailable("The current API Profile is not configured for image generation.")
        const resolution = resolveProfileReference(apiProfiles, reference)
        if (resolution.status !== "resolved") return unavailable("The current API Profile could not be resolved.")
        const apiProfile = resolution.profile
        if (!apiProfile.enabled) {
            return unavailable("The current API Profile is disabled.")
        }
        if (
            apiProfile.imageSource === undefined ||
            apiProfile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED ||
            apiProfile.imageSource === ImageGenerationSource.UNRECOGNIZED
        ) {
            return unavailable("Image generation is disabled for the current API Profile.")
        }
        const source = apiProfile.imageSource
        const isOpenAI = apiProfile.provider === "openai"
        const isOpenAiCodex = apiProfile.provider === "openai-codex"
        if (
            source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION ||
            source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED
        ) {
            if (source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED && !isOpenAI && !isOpenAiCodex) {
                return unavailable("Hosted image generation requires an OpenAI or OpenAI Codex Profile.")
            }
            if (source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION && !isOpenAI && !isOpenAiCodex) {
                return unavailable("GPT Subscription image generation requires an OpenAI or OpenAI Codex Profile.")
            }
            if (isOpenAI) {
                const selectedApiFormat =
                    apiProfile.openai?.apiFormat ?? openAiEndpointToApiFormat(apiProfile.openai?.apiEndpoint)
                const apiFormat = resolveApiFormat(selectedApiFormat, apiProfile.modelInfo, ApiFormat.OPENAI_CHAT)
                if (apiFormat !== ApiFormat.OPENAI_RESPONSES && apiFormat !== ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE) {
                    return unavailable("Responses image generation requires the OpenAI Responses transport.")
                }
            }
            if (!apiProfile.modelId) return unavailable("Responses image generation requires a configured conversation model.")
            const imageModelId = apiProfile.imageModelId || this.options.getDefaultImageModelId(apiProfile.provider)
            if (!imageModelId) return unavailable("The current API Profile has no available image model.")
            const model = this.options.getImageModel(apiProfile.provider, imageModelId)
            const capabilities = model?.capabilities
            if (!model || (capabilities?.supportsGeneration !== true && capabilities?.supportsEditing !== true)) {
                return unavailable("The selected image model is unavailable for the current API Profile.")
            }
            if (selector && ![apiProfile.id, apiProfile.name, ...(apiProfile.legacyNames ?? [])].includes(selector)) {
                return unavailable("The requested Image Profile does not match the current API Profile binding.")
            }
            return {
                profile: apiProfile,
                model,
                source,
                adapterId: isOpenAiCodex ? "openai-codex" : OPENAI_HOSTED_IMAGE_ADAPTER_ID,
            }
        }
        if (source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_API) {
            if (!isOpenAI) return unavailable("GPT API image generation requires an OpenAI API Profile.")
            const imageModelId = apiProfile.imageModelId || this.options.getDefaultImageModelId(apiProfile.provider)
            if (!imageModelId) return unavailable("The current OpenAI Profile has no available image model.")
            const model = this.options.getImageModel(apiProfile.provider, imageModelId)
            const capabilities = model?.capabilities
            if (!model || (capabilities?.supportsGeneration !== true && capabilities?.supportsEditing !== true)) {
                return unavailable("The selected image model is unavailable for GPT API image generation.")
            }
            return { profile: apiProfile, model, source, adapterId: "openai" }
        }
        if (source !== ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT) {
            return unavailable("The configured image source is unsupported.")
        }
        if (!apiProfile.imageModelId) {
            return unavailable("Image generation is not enabled for the current API Profile.")
        }
        if (apiProfile.imageModelId === GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID) {
            return unavailable("The legacy GPT Image 2 subscription alias is only available with GPT Subscription.")
        }
        let profile = apiProfile
        if (source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT) {
            const imageProfile = (this.options.readImageProfiles?.() ?? []).find(
                (candidate) => candidate.id === apiProfile.imageProfileId && candidate.enabled,
            )
            if (!imageProfile) return unavailable("The selected independent Image Profile is unavailable.")
            profile = ApiProfile.create({
                id: imageProfile.id,
                name: imageProfile.name,
                provider: imageProfile.provider,
                apiKey: imageProfile.apiKey,
                baseUrl: imageProfile.baseUrl,
                modelId: apiProfile.imageModelId,
                imageModelId: apiProfile.imageModelId,
                usedFor: [],
                enabled: true,
            })
        }

        if (selector && ![profile.id, profile.name, ...(profile.legacyNames ?? [])].includes(selector)) {
            return unavailable("The requested Image Profile does not match the current API Profile binding.")
        }
        const model = this.options.getImageModel(profile.provider, apiProfile.imageModelId)
        const capabilities = model?.capabilities
        if (!model || (capabilities?.supportsGeneration !== true && capabilities?.supportsEditing !== true)) {
            return unavailable("The selected image model is unavailable for the configured image source.")
        }
        return { profile, model, source, adapterId: profile.provider }
    }
}
