import type { ArtifactUrlDownloader } from "@core/artifacts/ArtifactResolver"
import { createTaskArtifactResolver, createTaskImagePreviewStore, getTaskArtifactDirectory } from "@core/artifacts/runtime"
import { readApiProfiles } from "@core/controller/file/getApiProfiles"
import { readImageGenerationProfiles } from "@core/controller/file/imageGenerationProfiles"
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import type { StateManager } from "@core/storage/StateManager"
import { GeminiImageGenerationAdapter } from "./adapters/GeminiImageGenerationAdapter"
import { OpenAIHostedImageGenerationAdapter } from "./adapters/OpenAIHostedImageGenerationAdapter"
import { OpenAIImageGenerationAdapter } from "./adapters/OpenAIImageGenerationAdapter"
import { OpenAiCodexHostedResponsesClient } from "./adapters/OpenAiCodexHostedResponsesClient"
import { ImageGenerationAdapterRegistry } from "./ImageGenerationAdapterRegistry"
import { ImageGenerationBudgetLedger } from "./ImageGenerationBudgetLedger"
import { ImageGenerationPolicy } from "./ImageGenerationPolicy"
import { ImageGenerationService } from "./ImageGenerationService"
import { ImageProfileResolver, OPENAI_HOSTED_IMAGE_ADAPTER_ID } from "./ImageProfileResolver"

export interface ImageGenerationRuntime {
    profileResolver: ImageProfileResolver
    adapterRegistry: ImageGenerationAdapterRegistry
    service: ImageGenerationService
}

export interface ImageGenerationTaskBinding {
    taskId: string
    ulid?: string
    getCurrentMode: () => "plan" | "act"
}

export interface ImageProfileReferenceBinding {
    profileId?: string
    profileName?: string
}

export interface CreateImageGenerationRuntimeOptions extends ImageGenerationTaskBinding {
    stateManager: StateManager
    urlDownloader?: ArtifactUrlDownloader
}

function isImageGenerationEnabled(stateManager: StateManager): boolean {
    return stateManager.getCanonicalSettingsKey("imageGenerationEnabled") === true
}

function createBoundImageProfileResolver(
    getCurrentProfileId: () => string | undefined,
    getCurrentProfileName: () => string | undefined,
): ImageProfileResolver {
    return new ImageProfileResolver({
        readApiProfiles,
        readImageProfiles: readImageGenerationProfiles,
        getCurrentProfileId,
        getCurrentProfileName,
        getImageModel: (providerId, modelId) => ModelRegistry.getInstance().getProviderModels(providerId)?.imageModels?.[modelId],
        getDefaultImageModelId: (providerId) => ModelRegistry.getInstance().getProviderModels(providerId)?.defaultImageModelId,
    })
}

export function createImageProfileResolver(
    stateManager: StateManager,
    binding: ImageGenerationTaskBinding,
): ImageProfileResolver {
    return createBoundImageProfileResolver(
        () => {
            const configuration = stateManager.getApiConfigurationForTask(binding.taskId)
            return binding.getCurrentMode() === "plan" ? configuration.planModeProfileId : configuration.actModeProfileId
        },
        () => {
            const configuration = stateManager.getApiConfigurationForTask(binding.taskId)
            return binding.getCurrentMode() === "plan" ? configuration.planModeProfile : configuration.actModeProfile
        },
    )
}

export function createImageProfileResolverForProfile(binding: ImageProfileReferenceBinding): ImageProfileResolver {
    return createBoundImageProfileResolver(
        () => binding.profileId,
        () => binding.profileName,
    )
}

export function hasAvailableImageProfile(stateManager: StateManager, binding: ImageGenerationTaskBinding): boolean {
    return resolveAvailableImageModelId(stateManager, binding) !== undefined
}

/** Returns the image model ID of the currently bound image profile, or undefined when image generation is unavailable. */
export function resolveAvailableImageModelId(
    stateManager: StateManager,
    binding: ImageGenerationTaskBinding,
): string | undefined {
    if (!isImageGenerationEnabled(stateManager)) return undefined
    return createImageProfileResolver(stateManager, binding).resolveAvailable()?.model.id
}

export function createImageGenerationRuntime(options: CreateImageGenerationRuntimeOptions): ImageGenerationRuntime {
    const profileResolver = createImageProfileResolver(options.stateManager, options)
    const adapterRegistry = new ImageGenerationAdapterRegistry()
    adapterRegistry.register("openai", (config) => new OpenAIImageGenerationAdapter(config))
    adapterRegistry.register(OPENAI_HOSTED_IMAGE_ADAPTER_ID, (config) => new OpenAIHostedImageGenerationAdapter(config))
    adapterRegistry.register(
        "openai-codex",
        (config) =>
            new OpenAIHostedImageGenerationAdapter({
                ...config,
                client: new OpenAiCodexHostedResponsesClient({
                    profileId: config.profile.id,
                    workspaceId: options.stateManager.getApiConfigurationForTask(options.taskId).workspaceId,
                    threadId: options.ulid ?? options.taskId,
                }),
            }),
    )
    adapterRegistry.register("gemini", (config) => new GeminiImageGenerationAdapter(config))
    const artifactResolver = createTaskArtifactResolver(options.taskId, { urlDownloader: options.urlDownloader })
    const previewStore = createTaskImagePreviewStore(options.taskId)
    const budgetLedger = new ImageGenerationBudgetLedger({
        taskId: options.taskId,
        taskDirectory: getTaskArtifactDirectory(options.taskId),
    })
    const service = new ImageGenerationService({
        profileResolver,
        adapterRegistry,
        policy: new ImageGenerationPolicy(),
        artifactResolver,
        previewStore,
        budgetLedger,
        isFeatureEnabled: () => isImageGenerationEnabled(options.stateManager),
    })
    return { profileResolver, adapterRegistry, service }
}
