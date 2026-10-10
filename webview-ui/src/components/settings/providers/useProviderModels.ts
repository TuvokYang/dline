import { EmptyRequest } from "@shared/proto/dline/common"
import type { AvailableModelsResponse, ImageModelInfo, ModelInfo, ProviderModelGroup } from "@shared/proto/dline/models"
import { useContext, useEffect, useState } from "react"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

export interface ProviderModelsResult {
    models: Record<string, ModelInfo>
    defaultModelId: string
    modelInfoSaneDefaults: ModelInfo
    imageModels: Record<string, ImageModelInfo>
    defaultImageModelId: string
    loading: boolean
    error?: Error
}

let sharedCatalog: ProviderModelGroup[] = []
let sharedCatalogLoaded = false
let sharedCatalogError: Error | undefined
let sharedCatalogPromise: Promise<void> | undefined
let sharedCatalogVersion = -1
const catalogListeners = new Set<() => void>()

function notifyCatalogListeners(): void {
    for (const listener of catalogListeners) listener()
}

function loadModelCatalog(providersVersion: number): Promise<void> {
    if (sharedCatalogLoaded && sharedCatalogVersion === providersVersion) return Promise.resolve()
    if (sharedCatalogPromise) {
        return sharedCatalogPromise.then(() => loadModelCatalog(providersVersion))
    }

    const request = ModelsServiceClient.getAvailableModels({} as EmptyRequest)
        .then((response: AvailableModelsResponse) => {
            sharedCatalog = response.providers || []
            sharedCatalogLoaded = true
            sharedCatalogVersion = providersVersion
            sharedCatalogError = undefined
            notifyCatalogListeners()
        })
        .catch((error: unknown) => {
            sharedCatalogError = error instanceof Error ? error : new Error(String(error))
            notifyCatalogListeners()
        })
        .finally(() => {
            if (sharedCatalogPromise === request) sharedCatalogPromise = undefined
        })

    sharedCatalogPromise = request
    return request
}

export function getCachedProviderDefaultModelId(providerId: string): string {
    const group = sharedCatalog.find((item) => item.provider === providerId)
    return group?.defaultModelId || group?.models[0]?.id || ""
}

export function getCachedProviderDefaultImageModelId(providerId: string): string {
    const group = sharedCatalog.find((item) => item.provider === providerId)
    return group?.defaultImageModelId || group?.imageModels[0]?.id || ""
}

/** All consumers share one registry catalog RPC instead of loading all models per card/editor. */
export function useProviderModels(providerId: string): ProviderModelsResult {
    const [, forceRender] = useState(0)
    const extensionState = useContext(ExtensionStateContext)
    const providersVersion = extensionState?.providersVersion ?? 0

    useEffect(() => {
        const listener = () => forceRender((value) => value + 1)
        catalogListeners.add(listener)
        void loadModelCatalog(providersVersion)
        return () => {
            catalogListeners.delete(listener)
        }
    }, [providersVersion])

    const group = sharedCatalog.find((item) => item.provider === providerId)
    const models: Record<string, ModelInfo> = {}
    for (const model of group?.models || []) models[model.id] = model
    if (providerId === "vercel-ai-gateway") {
        Object.assign(models, extensionState?.vercelAiGatewayModels ?? {})
    }
    const defaultModelId = getCachedProviderDefaultModelId(providerId) || Object.keys(models)[0] || ""
    const modelInfoSaneDefaults = models[defaultModelId] || Object.values(models)[0] || ({} as ModelInfo)
    const imageModels: Record<string, ImageModelInfo> = {}
    for (const model of group?.imageModels || []) imageModels[model.id] = model
    const defaultImageModelId = getCachedProviderDefaultImageModelId(providerId) || Object.keys(imageModels)[0] || ""

    return {
        models,
        defaultModelId,
        modelInfoSaneDefaults,
        imageModels,
        defaultImageModelId,
        loading: !sharedCatalogLoaded && !sharedCatalogError,
        error: sharedCatalogError,
    }
}
