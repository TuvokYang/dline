import type { ModelPricing } from "@shared/proto/dline/models/metadata"
import type { ProviderCatalog, ProviderModelsConfig } from "@shared/providers/types"

/** Traverse chat model declarations only; image prices and catalog metadata retain their owners. */
export function mapCatalogPricing(
    config: ProviderModelsConfig,
    project: (pricing: ModelPricing | undefined) => ModelPricing | undefined,
): ProviderModelsConfig {
    const migrate = <T extends ProviderCatalog>(catalog: T): T => ({
        ...catalog,
        models: Object.fromEntries(
            Object.entries(catalog.models).map(([id, model]) => [id, { ...model, pricing: project(model.pricing) }]),
        ),
    })
    return {
        ...migrate(config),
        ...(config.catalogs
            ? { catalogs: Object.fromEntries(Object.entries(config.catalogs).map(([key, catalog]) => [key, migrate(catalog)])) }
            : {}),
    }
}
