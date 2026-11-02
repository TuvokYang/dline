import { getProviderCatalog, getProviderSeedConfig } from "@shared/providers/model-infos"
import type { ModelInfo, ProviderModelsConfig } from "@shared/providers/types"
import { Logger } from "@shared/services/Logger"
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

/**
 * Persist one dynamic provider catalog and refresh only that registry entry.
 *
 * The write is skipped when the serialized catalogue already matches the stored
 * file. A vendor listing that has not changed is the common case, and rewriting
 * it would change the file mtime for identical content, which is exactly what
 * makes the registry watcher replay a full reload and republish the Webview
 * state for a catalog it already holds. A changed document is written and then
 * reported by that same watcher, which is how the open settings page learns
 * about the new models.
 */
export async function persistProviderCatalog(options: PersistProviderCatalogOptions): Promise<ProviderModelsConfig> {
    const registry = ModelRegistry.getInstance()
    await registry.waitForDeferredProviders()
    // Discovery is addressed by catalog key, so `opencode-go` names an
    // alternative catalog of the `opencode` entry. Only that entry owns a file,
    // a self-write record and a reload scope; the catalog key only selects which
    // region of it is replaced.
    const ownerId = getProviderCatalog(options.providerId)?.provider.provider ?? options.providerId
    // Two catalog keys of one provider share one document, so they must not
    // interleave: both count as "their own" write for the registry and both read
    // the owner before the other has landed. Chaining per owner makes the second
    // write compose with what the first one stored instead of replacing it.
    const previous = ownerWrites.get(ownerId) ?? Promise.resolve()
    const current = previous.then(
        () => writeOwnerCatalog(registry, ownerId, options),
        () => writeOwnerCatalog(registry, ownerId, options),
    )
    // The tail is what the next caller waits on; it swallows the rejection so one
    // failed write cannot poison every later one for this provider.
    const tail = current.then(
        () => undefined,
        () => undefined,
    )
    ownerWrites.set(ownerId, tail)
    try {
        return await current
    } finally {
        if (ownerWrites.get(ownerId) === tail) {
            ownerWrites.delete(ownerId)
        }
    }
}

/** Pending write per owner document, so one provider's catalogs never overlap. */
const ownerWrites = new Map<string, Promise<void>>()

async function writeOwnerCatalog(
    registry: ModelRegistry,
    ownerId: string,
    options: PersistProviderCatalogOptions,
): Promise<ProviderModelsConfig> {
    const filePath = path.join(registry.providersDir, getProviderConfigFileName(ownerId))
    // Compose from the document on disk, not from the cached copy.
    //
    // The cached entry is only as fresh as the last reload. A reload is
    // debounced and a second window can commit this same document at any time,
    // so a write built from the cache replaces the whole owner entry with a
    // snapshot that never saw the other catalog's latest models. Reading the
    // document here means only the target catalog is replaced.
    const storedOwner = await readStoredOwner(filePath, ownerId)
    const owner = storedOwner ?? registry.getProviderModels(ownerId)
    const existing = catalogForWrite(registry, owner, options.providerId)
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

    const config = buildConfig(ownerId, owner, options, models, defaultModelId, {
        catalogKey: options.providerId,
    })

    await fs.mkdir(registry.providersDir, { recursive: true })
    const serialized = serializeProviderCatalog(config)
    const stored = await readCachedFile(filePath)
    if (stored === serialized) {
        return config
    }

    // The registry reloads this entry itself so the writer sees its own result
    // immediately. The watcher still reports the same write and republishes the
    // catalog through `onChange`, which is the notification the open settings
    // page needs; suppressing it here would strand every provider that persists
    // without posting state itself.
    await fs.writeFile(filePath, serialized, "utf8")
    await registry.reload({ includeProviderIds: new Set([ownerId]) })
    return config
}

/**
 * Read the owner entry as it exists on disk, or `undefined` when there is none.
 *
 * An unreadable or unparsable document is treated as absent: the caller then
 * composes from the cached entry, which is what the previous behaviour did, so a
 * damaged file is replaced rather than blocking discovery.
 */
async function readStoredOwner(filePath: string, ownerId: string): Promise<ProviderModelsConfig | undefined> {
    const raw = await readCachedFile(filePath)
    if (raw === undefined) return undefined
    try {
        const parsed = JSON.parse(raw) as ProviderModelsConfig
        if (!parsed || typeof parsed !== "object" || !parsed.models) return undefined
        return { ...parsed, provider: parsed.provider || ownerId }
    } catch (error) {
        Logger.warn(`[ModelRegistry] Ignoring unparsable provider catalog ${path.basename(filePath)}:`, error)
        return undefined
    }
}

/**
 * The catalog a write targets, as the document on disk states it.
 *
 * A primary write replaces the primary catalog wholesale, so it needs no
 * existing value. An alternative write overlays its own reconciliation, and that
 * decision belongs to the catalog the document currently holds.
 */
function catalogForWrite(
    registry: ModelRegistry,
    owner: ProviderModelsConfig | undefined,
    catalogKey: string,
): ProviderModelsConfig | undefined {
    const stored = owner?.catalogs?.[catalogKey]
    if (stored) {
        return { ...owner, ...stored, models: stored.models ?? {} }
    }
    return registry.getProviderCatalog(catalogKey)
}

/**
 * Compose the document to write.
 *
 * The owner entry keeps everything the incoming options do not describe: its
 * other catalogs, its plan pricing and its image models. Writing an alternative
 * catalog therefore updates only that catalog's models, and writing the primary
 * catalog keeps the alternative one intact, so refreshing one never erases the
 * data the other just discovered.
 */
function buildConfig(
    ownerId: string,
    owner: ProviderModelsConfig | undefined,
    options: PersistProviderCatalogOptions,
    models: Record<string, ModelInfo>,
    defaultModelId: string | undefined,
    target: { catalogKey: string },
): ProviderModelsConfig {
    const isPrimary = target.catalogKey === ownerId
    const ownerFields = withoutEmptyImageModels(owner)
    if (isPrimary) {
        return {
            ...ownerFields,
            provider: ownerId,
            providerName: options.providerName,
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
            billingMode: options.billingMode,
            models,
            ...(defaultModelId ? { defaultModelId } : {}),
        } as ProviderModelsConfig
    }
    // The owner entry is normally in memory, but a first write into an empty
    // directory must still produce a loadable document: `models` is required, so
    // the seed's primary catalog fills it rather than leaving the file to be
    // rejected on the next load.
    const ownerModels = owner?.models ?? getProviderSeedConfig(ownerId)?.models
    return {
        ...ownerFields,
        provider: ownerId,
        providerName: owner?.providerName ?? options.providerName,
        billingMode: owner?.billingMode ?? options.billingMode,
        models: ownerModels ?? {},
        catalogs: {
            ...(owner?.catalogs ?? {}),
            [target.catalogKey]: {
                ...(owner?.catalogs?.[target.catalogKey] ?? {}),
                models,
                ...(defaultModelId ? { defaultModelId } : {}),
            },
        },
    } as ProviderModelsConfig
}

/**
 * Drop an empty image catalog before writing.
 *
 * Reconciliation fills a missing `imageModels` with `{}`, which is the same fact
 * as having none. Keeping it would make every write differ from the document it
 * just produced and rewrite the file for no change.
 */
function withoutEmptyImageModels(owner: ProviderModelsConfig | undefined): Partial<ProviderModelsConfig> {
    if (!owner?.imageModels || Object.keys(owner.imageModels).length > 0) {
        return owner ?? {}
    }
    const { imageModels: _none, ...rest } = owner
    return rest
}

async function readCachedFile(filePath: string): Promise<string | undefined> {
    try {
        return await fs.readFile(filePath, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
    }
}
