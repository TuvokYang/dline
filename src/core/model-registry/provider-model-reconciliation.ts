import { mergeCapabilities } from "@shared/providers/effective-model-info"
import type { ImageModelInfo, ModelInfo, ProviderCatalog, ProviderModelsConfig } from "@shared/providers/types"

export type ProviderModelReconciliationMode = "fill-missing" | "refresh-built-ins" | "overlay-remote" | "replace"

/**
 * Whether a stored entry came from the built-in data rather than a person.
 *
 * An absent marker means built-in: entries written before the marker existed, and
 * every entry a vendor listing persisted, carry no `userDefined` field. Reading it
 * as "not built-in" would make those entries permanently unrefreshable.
 */
function isBuiltIn(model: { userDefined?: boolean } | undefined): boolean {
    return model?.userDefined !== true
}

function mergeBuiltInModelDefaults(seed: ModelInfo, stored: ModelInfo): ModelInfo {
    return {
        ...seed,
        ...stored,
        capabilities:
            seed.capabilities || stored.capabilities
                ? mergeCapabilities(seed.capabilities, stored.capabilities ?? {})
                : undefined,
        pricing: stored.pricing ?? seed.pricing,
        apiFormats: stored.apiFormats ?? seed.apiFormats,
    }
}

function mergeBuiltInImageModelDefaults(seed: ImageModelInfo, stored: ImageModelInfo): ImageModelInfo {
    return {
        ...seed,
        ...stored,
        capabilities: seed.capabilities || stored.capabilities ? { ...seed.capabilities, ...stored.capabilities } : undefined,
        pricing: seed.pricing || stored.pricing ? { ...seed.pricing, ...stored.pricing } : undefined,
    }
}

function reconcileImageModels(
    seed: ProviderModelsConfig,
    stored: ProviderModelsConfig,
    mode: ProviderModelReconciliationMode,
): Record<string, ImageModelInfo> | undefined {
    const seedModels = seed.imageModels ?? {}
    const storedModels = stored.imageModels ?? {}
    if (mode === "fill-missing") {
        return Object.fromEntries(
            Object.entries(storedModels).map(([modelId, storedModel]) => {
                const seedModel = seedModels[modelId]
                if (!seedModel || storedModel.userDefined === true) return [modelId, storedModel]
                return [modelId, mergeBuiltInImageModelDefaults(seedModel, storedModel)]
            }),
        )
    }

    const models: Record<string, ImageModelInfo> = {}
    for (const [modelId, seedModel] of Object.entries(seedModels)) {
        const storedModel = storedModels[modelId]
        models[modelId] = storedModel?.userDefined === true ? storedModel : { ...seedModel, userDefined: false }
    }
    for (const [modelId, storedModel] of Object.entries(storedModels)) {
        if (seedModels[modelId] === undefined) models[modelId] = { ...storedModel, userDefined: true }
    }
    return Object.keys(models).length > 0 ? models : undefined
}

/** Drop keys whose value is undefined so that a spread never erases an existing field. */
function withoutUndefined<T extends object>(source: T): Partial<T> {
    return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Partial<T>
}

/**
 * Overlay one remote listing entry on top of the stored model.
 *
 * Vendor listings are a supplement to the local catalog rather than a
 * replacement: fields the vendor does not report keep their stored values. This
 * matters most for pricing, which several listing endpoints omit entirely.
 */
function overlayRemoteModel(remote: ModelInfo, stored: ModelInfo): ModelInfo {
    return {
        ...stored,
        ...withoutUndefined(remote),
        capabilities:
            remote.capabilities || stored.capabilities
                ? mergeCapabilities(stored.capabilities, remote.capabilities ?? {})
                : undefined,
        pricing: remote.pricing ?? stored.pricing,
        apiFormats: remote.apiFormats ?? stored.apiFormats,
        userDefined: stored.userDefined === true ? true : false,
    }
}

/**
 * Merge a remote catalog into the stored one.
 *
 * Models the vendor no longer lists are kept, because a listing outage must not
 * erase a working local configuration. Explicit user models are never touched.
 */
function overlayRemoteModels(remote: ProviderModelsConfig, stored: ProviderModelsConfig): Record<string, ModelInfo> {
    const models: Record<string, ModelInfo> = {}

    for (const [modelId, storedModel] of Object.entries(stored.models)) {
        models[modelId] = storedModel
    }

    for (const [modelId, remoteModel] of Object.entries(remote.models)) {
        const storedModel = stored.models[modelId]
        if (storedModel?.userDefined === true) {
            continue
        }
        models[modelId] = storedModel ? overlayRemoteModel(remoteModel, storedModel) : { ...remoteModel, userDefined: false }
    }

    return models
}

/**
 * Reconcile a persisted provider catalog with the current built-in metadata.
 * Explicit and legacy-unmarked user models are preserved; known built-ins are
 * refreshed, and retired models explicitly marked as built-in are removed.
 */
export function reconcileProviderModels(
    seed: ProviderModelsConfig,
    stored: ProviderModelsConfig,
    mode: ProviderModelReconciliationMode,
): ProviderModelsConfig {
    if (mode === "replace") {
        return seed
    }

    if (mode === "overlay-remote") {
        return {
            ...stored,
            ...seed,
            models: overlayRemoteModels(seed, stored),
            imageModels: reconcileImageModels(seed, stored, "fill-missing"),
            defaultImageModelId: stored.defaultImageModelId ?? seed.defaultImageModelId,
        }
    }

    if (mode === "fill-missing") {
        return {
            ...stored,
            imageModels: reconcileImageModels(seed, stored, mode),
            defaultImageModelId: stored.defaultImageModelId ?? seed.defaultImageModelId,
            models: Object.fromEntries(
                Object.entries(stored.models).map(([modelId, storedModel]) => {
                    const seedModel = seed.models[modelId]
                    if (!seedModel || storedModel.userDefined === true) {
                        return [modelId, storedModel]
                    }
                    return [modelId, mergeBuiltInModelDefaults(seedModel, storedModel)]
                }),
            ),
        }
    }

    const models: Record<string, ModelInfo> = {}

    // A seed that declares no model owns no built-in entry to refresh. Providers
    // whose catalog is fully derived from a vendor listing (OpenCode) declare
    // nothing locally, so every stored entry was written by discovery. Treating
    // those as retired built-ins would delete them on each startup, and
    // overwriting a listed entry with a seed that states nothing would drop the
    // limits and capabilities the vendor published.
    if (Object.keys(seed.models).length === 0) {
        for (const [modelId, storedModel] of Object.entries(stored.models)) {
            models[modelId] = storedModel
        }
        return {
            ...seed,
            ...stored,
            models,
            // The primary catalog states nothing, but an alternative catalog may
            // still declare its own models, and those have built-in entries to
            // retire. Skipping the call here is what left a cleaned catalog
            // untouched whenever the primary happened to be listing-derived.
            catalogs: reconcileCatalogs(seed, stored),
            imageModels: reconcileImageModels(seed, stored, mode),
            defaultImageModelId: stored.defaultImageModelId ?? seed.defaultImageModelId,
        }
    }

    for (const [modelId, seedModel] of Object.entries(seed.models)) {
        const storedModel = stored.models[modelId]
        if (storedModel?.userDefined === true) {
            models[modelId] = storedModel
            continue
        }

        models[modelId] = { ...seedModel, userDefined: false }
    }

    for (const [modelId, storedModel] of Object.entries(stored.models)) {
        if (seed.models[modelId] !== undefined || storedModel.userDefined === false) {
            continue
        }
        models[modelId] = { ...storedModel, userDefined: true }
    }

    return {
        ...seed,
        ...stored,
        models,
        catalogs: reconcileCatalogs(seed, stored),
        imageModels: reconcileImageModels(seed, stored, mode),
        defaultImageModelId: stored.defaultImageModelId ?? seed.defaultImageModelId,
    }
}

/**
 * Reconcile every alternative catalog the seed declares.
 *
 * A catalog is cleaned the same way as the primary one: an entry the seed no
 * longer lists is retired when it is built-in, and kept as a user model when it
 * says otherwise. Catalogs the seed does not declare are kept untouched, because
 * a catalog this build knows nothing about has no baseline to retire against.
 *
 * A catalog whose seed declares no model is fully listing-derived (the OpenCode
 * plans), so it keeps exactly what discovery wrote — the same rule the primary
 * catalog follows above.
 */
function reconcileCatalogs(
    seed: ProviderModelsConfig,
    stored: ProviderModelsConfig,
): Record<string, ProviderCatalog> | undefined {
    const seedCatalogs = seed.catalogs ?? {}
    const storedCatalogs = stored.catalogs ?? {}
    const seedKeys = Object.keys(seedCatalogs)
    if (seedKeys.length === 0 && Object.keys(storedCatalogs).length === 0) {
        return undefined
    }

    const catalogs: Record<string, ProviderCatalog> = { ...storedCatalogs }
    for (const catalogKey of seedKeys) {
        const seedCatalog = seedCatalogs[catalogKey]
        const storedCatalog = storedCatalogs[catalogKey]
        if (!seedCatalog || !storedCatalog) {
            // A catalog the document does not hold yet is the seed's own statement;
            // a catalog the seed does not declare keeps whatever was stored.
            if (seedCatalog) catalogs[catalogKey] = seedCatalog
            continue
        }

        const seedModels = seedCatalog.models ?? {}
        if (Object.keys(seedModels).length === 0) {
            continue
        }

        const models: Record<string, ModelInfo> = {}
        for (const [modelId, seedModel] of Object.entries(seedModels)) {
            const storedModel = storedCatalog.models?.[modelId]
            models[modelId] = storedModel && !isBuiltIn(storedModel) ? storedModel : { ...seedModel, userDefined: false }
        }
        for (const [modelId, storedModel] of Object.entries(storedCatalog.models ?? {})) {
            if (seedModels[modelId] !== undefined) continue
            if (!isBuiltIn(storedModel)) {
                models[modelId] = storedModel
            }
            // A built-in entry the seed no longer declares is retired here: this is
            // the only place a stale vendor catalog can be cleaned up.
        }
        catalogs[catalogKey] = {
            ...seedCatalog,
            ...storedCatalog,
            models,
            // A default naming a model that just disappeared would leave the
            // catalog unselectable.
            defaultModelId:
                storedCatalog.defaultModelId && models[storedCatalog.defaultModelId]
                    ? storedCatalog.defaultModelId
                    : seedCatalog.defaultModelId && models[seedCatalog.defaultModelId]
                      ? seedCatalog.defaultModelId
                      : undefined,
        }
    }

    return catalogs
}

/** Add the built-in marker to every model in a newly generated seed file. */
export function markBuiltInModels(config: ProviderModelsConfig): ProviderModelsConfig {
    return {
        ...config,
        models: Object.fromEntries(
            Object.entries(config.models).map(([modelId, model]) => [modelId, { ...model, userDefined: false }]),
        ),
        imageModels: config.imageModels
            ? Object.fromEntries(
                  Object.entries(config.imageModels).map(([modelId, model]) => [modelId, { ...model, userDefined: false }]),
              )
            : undefined,
    }
}
