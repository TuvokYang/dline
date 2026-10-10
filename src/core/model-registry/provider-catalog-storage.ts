import type { ModelInfo, ProviderModelsConfig } from "@shared/providers/types"
import fs from "fs/promises"
import * as path from "path"
import { ModelRegistry } from "./ModelRegistry"
import { getProviderConfigFileName } from "./provider-config-file"
import { type ProviderModelReconciliationMode, reconcileProviderModels } from "./provider-model-reconciliation"

export interface PersistProviderCatalogOptions {
    providerId: string
    providerName: string
    baseUrl?: string
    billingMode: string
    models: Record<string, ModelInfo>
    preferredDefaultModelId?: string
    /**
     * How the incoming catalog combines with the stored one. Vendor-derived
     * catalogs replace it outright; listings that only supplement local metadata
     * should overlay instead. Defaults to `replace` to preserve existing callers.
     */
    reconciliationMode?: ProviderModelReconciliationMode
}

/** Serialize provider catalogs with stable, human-editable formatting. */
export function serializeProviderCatalog(config: ProviderModelsConfig): string {
    return `${JSON.stringify(config, null, "\t")}\n`
}

/** Persist one dynamic provider catalog and refresh only that registry entry. */
export async function persistProviderCatalog(options: PersistProviderCatalogOptions): Promise<ProviderModelsConfig> {
    const registry = ModelRegistry.getInstance()
    await registry.waitForDeferredProviders()
    const existing = registry.getProviderModels(options.providerId)
    const incoming = Object.fromEntries(
        Object.entries(options.models).map(([modelId, model]) => [
            modelId,
            { ...model, id: modelId, name: model.name || modelId, userDefined: false },
        ]),
    )
    const mode = options.reconciliationMode ?? "replace"
    const models =
        mode === "replace" || !existing
            ? incoming
            : reconcileProviderModels({ ...existing, models: incoming }, existing, mode).models
    const modelIds = Object.keys(models).sort((left, right) => left.localeCompare(right))
    const defaultModelId =
        (existing?.defaultModelId && models[existing.defaultModelId] ? existing.defaultModelId : undefined) ??
        (options.preferredDefaultModelId && models[options.preferredDefaultModelId]
            ? options.preferredDefaultModelId
            : modelIds[0])
    const config: ProviderModelsConfig = {
        provider: options.providerId,
        providerName: options.providerName,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        billingMode: options.billingMode,
        models,
        ...(defaultModelId ? { defaultModelId } : {}),
    }

    await fs.mkdir(registry.providersDir, { recursive: true })
    await fs.writeFile(
        path.join(registry.providersDir, getProviderConfigFileName(options.providerId)),
        serializeProviderCatalog(config),
        "utf8",
    )
    await registry.reload({ includeProviderIds: new Set([options.providerId]) })
    return config
}
