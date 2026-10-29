/**
 * Handler for getAvailableModels RPC.
 *
 * Returns all available models across configured providers from ModelRegistry,
 * grouped by provider for subagent model selection UI.
 */

import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { AvailableModelsResponse, ImageModelInfo, ModelInfo, ProviderModelGroup } from "@shared/proto/dline/models"
import type { Controller } from ".."

/**
 * Get all available models grouped by provider.
 * Uses layered ModelInfo (proto/dline/models.proto) with capabilities + pricing nesting.
 */
export async function getAvailableModels(_controller: Controller): Promise<AvailableModelsResponse> {
    const registry = ModelRegistry.getInstance()

    if (!registry.isInitialized) {
        await registry.initialize()
    }
    await registry.waitForDeferredProviders()

    const allModels = registry.getAllModels()

    const providers: ProviderModelGroup[] = allModels.map((group) =>
        ProviderModelGroup.create({
            provider: group.provider,
            providerName: group.providerName,
            defaultModelId: group.defaultModelId,
            models: group.models.map((model) => ModelInfo.create(model)),
            defaultImageModelId: group.defaultImageModelId,
            imageModels: (group.imageModels ?? []).map((model) => ImageModelInfo.create(model)),
        }),
    )

    return AvailableModelsResponse.create({
        providers,
    })
}
