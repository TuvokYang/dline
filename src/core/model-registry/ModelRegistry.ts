/**
 * ModelRegistry — central service for provider model configuration.
 *
 * Loads provider model configs from ~/.dline/providers/*.json,
 * caches them in memory, and watches for file changes.
 */
import { getDlineHomePath } from "@core/storage/disk"
import { ServerTool, serverToolFromJSON } from "@shared/proto/dline/models/metadata"
import { getProviderCatalog, getProviderCatalogKeys, getProviderSeedConfig } from "@shared/providers/model-infos"
import { migrateModelPricing } from "@shared/providers/pricing-shape"
import { resolvePrimaryCatalogKey } from "@shared/providers/provider-catalog-key"
import type { ImageModelInfo, ModelInfo, ProviderModelsConfig } from "@shared/providers/types"
import { Logger } from "@shared/services/Logger"
import chokidar, { type FSWatcher } from "chokidar"
import fs from "fs/promises"
import * as path from "path"
import { mapCatalogPricing } from "./model-pricing-migration"
import { DEFERRED_PROVIDER_IDS, isAlternativeCatalogKey, isListingDerivedModel } from "./provider-catalog-policy"
import { getProviderConfigFileName, getProviderIdFromConfigFile } from "./provider-config-file"
import { reconcileProviderModels } from "./provider-model-reconciliation"

const PROVIDERS_DIR_NAME = "providers"

function enrichMissingSeedMetadata(providerId: string, config: ProviderModelsConfig): ProviderModelsConfig {
    const seedConfig = getProviderSeedConfig(providerId)
    if (!seedConfig) {
        return config
    }
    return reconcileProviderModels(seedConfig, config, "fill-missing")
}

function withRequiredServerTool(model: ModelInfo, tool: ServerTool): ModelInfo {
    const tools = model.capabilities?.tools ?? []
    if (tools.includes(tool)) return model
    return {
        ...model,
        capabilities: {
            ...model.capabilities,
            tools: [...tools, tool],
        },
    }
}

function parseProviderModelsConfig(providerId: string, raw: string): ProviderModelsConfig {
    const config = JSON.parse(raw) as ProviderModelsConfig
    if (!config || typeof config !== "object") {
        throw new Error(`Provider config "${providerId}" must be an object`)
    }
    if (!config.models || typeof config.models !== "object" || Array.isArray(config.models)) {
        throw new Error(`Provider config "${providerId}" must define models as a keyed object`)
    }
    for (const model of Object.values(config.models)) {
        const capabilities = model.capabilities
        if (!capabilities || !Array.isArray(capabilities.tools)) continue
        capabilities.tools = capabilities.tools
            .map((tool) => (typeof tool === "string" ? serverToolFromJSON(tool) : tool))
            .filter((tool) => tool !== ServerTool.UNRECOGNIZED)
    }
    return enrichMissingSeedMetadata(config.provider || providerId, mapCatalogPricing(config, migrateModelPricing))
}

export class ModelRegistry {
    private static instance?: ModelRegistry
    private cache = new Map<string, ProviderModelsConfig>()
    private watcher: FSWatcher | null = null
    private initialized = false
    private onChangeCallbacks: Array<() => void> = []
    private deferredProvidersPromise: Promise<void> | null = null
    /** Tail of the reload passes, so a newer snapshot never lands before an older one. */
    private reloadQueue: Promise<void> = Promise.resolve()
    private _version = 0

    /** Monotonically increasing version number, incremented on each reload. */
    get version(): number {
        return this._version
    }

    private constructor() {}

    /** Get the singleton instance. */
    static getInstance(): ModelRegistry {
        if (!ModelRegistry.instance) {
            ModelRegistry.instance = new ModelRegistry()
        }
        return ModelRegistry.instance
    }

    /** Absolute path to ~/.dline/providers/ */
    get providersDir(): string {
        return path.join(getDlineHomePath(), PROVIDERS_DIR_NAME)
    }

    /** Whether the registry has been initialized. */
    get isInitialized(): boolean {
        return this.initialized
    }

    /**
     * Register a callback to be invoked when provider JSON files change (fs-watch).
     * Returns an unsubscribe function.
     */
    onChange(cb: () => void): () => void {
        this.onChangeCallbacks.push(cb)
        return () => {
            this.onChangeCallbacks = this.onChangeCallbacks.filter((c) => c !== cb)
        }
    }

    /**
     * Initialize the registry: load all JSON files and start watching.
     * Safe to call multiple times — subsequent calls are no-ops.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return

        // Ensure the providers directory exists
        await fs.mkdir(this.providersDir, { recursive: true })

        // Load lightweight provider catalogs before the extension continues initializing.
        await this.reload({ excludeProviderIds: DEFERRED_PROVIDER_IDS })

        // Start watching for changes
        this.startWatch()

        this.initialized = true
        this.deferredProvidersPromise = this.reload({ includeProviderIds: DEFERRED_PROVIDER_IDS })
            .then(() => {
                this.onChangeCallbacks.forEach((cb) => cb())
            })
            .catch((err) => Logger.error("[ModelRegistry] Failed to load deferred provider configs:", err))
        Logger.log(`[ModelRegistry] Initialized, ${this.cache.size} provider(s) loaded from ${this.providersDir}`)
    }

    /**
     * Reload from disk, one pass at a time.
     *
     * A pass reads the directory and then publishes what it read, so two
     * overlapping passes can apply their snapshots out of order: a watcher pass
     * that started before a write would land its older snapshot after the
     * writer's own reload and roll the cache back. Serializing the passes makes
     * every snapshot be applied in the order it was read.
     */
    async reload(options?: {
        includeProviderIds?: ReadonlySet<string>
        excludeProviderIds?: ReadonlySet<string>
        /** Apply the change without bumping {@link version} or publishing it. */
        silent?: boolean
    }): Promise<void> {
        const pass = this.reloadQueue.then(
            () => this.applyReload(options),
            () => this.applyReload(options),
        )
        this.reloadQueue = pass.then(
            () => undefined,
            () => undefined,
        )
        return pass
    }

    private async applyReload(options?: {
        includeProviderIds?: ReadonlySet<string>
        excludeProviderIds?: ReadonlySet<string>
        silent?: boolean
    }): Promise<void> {
        try {
            const entries = await fs.readdir(this.providersDir)
            const jsonFiles = entries.filter((fileName) => {
                if (!fileName.endsWith(".json")) return false
                const providerId = getProviderIdFromConfigFile(fileName)
                if (options?.includeProviderIds && !options.includeProviderIds.has(providerId)) return false
                if (options?.excludeProviderIds?.has(providerId)) return false
                return true
            })
            if (jsonFiles.length === 0 && options?.includeProviderIds) {
                return
            }
            const loadedConfigs = new Map()

            for (const fileName of jsonFiles) {
                const fileProviderId = getProviderIdFromConfigFile(fileName)
                // A file left over from a build that registered an alternative
                // catalog as its own provider must not resurrect it: the catalog
                // now belongs to a parent entry, and loading it here would put a
                // second selectable provider back into the registry.
                if (isAlternativeCatalogKey(fileProviderId)) {
                    Logger.warn(`[ModelRegistry] Ignoring ${fileName}: "${fileProviderId}" is now a catalog of another provider.`)
                    continue
                }
                try {
                    const filePath = path.join(this.providersDir, fileName)
                    const raw = await fs.readFile(filePath, "utf8")
                    const config = parseProviderModelsConfig(fileProviderId, raw)
                    const providerId = config.provider || fileProviderId
                    const existing = loadedConfigs.get(providerId)
                    const canonicalFileName = getProviderConfigFileName(providerId)
                    if (!existing || fileName === canonicalFileName || existing.fileName !== canonicalFileName) {
                        loadedConfigs.set(providerId, { config, fileName })
                    }
                } catch (err) {
                    Logger.warn(`[ModelRegistry] Failed to parse ${fileName}:`, err)
                }
            }

            for (const [providerId, { config }] of loadedConfigs) {
                this.cache.set(providerId, config)
            }

            // Remove cached entries for deleted files within the reloaded scope.
            const loadedIds = new Set(loadedConfigs.keys())
            for (const id of this.cache.keys()) {
                const isInScope =
                    (!options?.includeProviderIds || options.includeProviderIds.has(id)) && !options?.excludeProviderIds?.has(id)
                if (isInScope && !loadedIds.has(id)) {
                    this.cache.delete(id)
                }
            }

            if (options?.silent !== true) {
                this._version++
            }
            // `cache.size` is the total catalogue count and says nothing about this
            // pass, which can be scoped to a single provider. Report what the pass
            // actually read so the line reflects real work.
            Logger.debug(
                `[ModelRegistry] Reloaded ${loadedConfigs.size} of ${jsonFiles.length} config file(s); ${this.cache.size} provider(s) cached`,
            )
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                // Directory doesn't exist yet, that's fine
                return
            }
            Logger.error("[ModelRegistry] Failed to reload provider configs:", err)
        }
    }

    /** Start a filesystem watcher for hot-reload. */
    private startWatch(): void {
        if (this.watcher) return

        try {
            this.watcher = chokidar.watch(this.providersDir, {
                persistent: false,
                ignoreInitial: true,
                awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
            })
            this.watcher.on("add", (filePath) => this.noteChangedFile(filePath))
            this.watcher.on("change", (filePath) => this.noteChangedFile(filePath))
            this.watcher.on("unlink", (filePath) => this.noteChangedFile(filePath))
            this.watcher.on("error", (err) => {
                Logger.warn("[ModelRegistry] Watcher error:", err)
            })
        } catch (err) {
            Logger.warn("[ModelRegistry] Failed to start file watcher:", err)
        }
    }

    /** Wait for startup-deferred provider catalogs to finish loading. */
    async waitForDeferredProviders(): Promise<void> {
        await this.deferredProvidersPromise
    }

    private reloadTimer: NodeJS.Timeout | null = null

    private noteChangedFile(_fileName: string): void {
        this.scheduleReload()
    }

    private scheduleReload(): void {
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(async () => {
            this.reloadTimer = null
            // Every persisted catalog must still reach `onChange`:
            // itself only refreshes that registry entry, so the watcher notification
            // is what publishes the new model list to the open settings page. The
            // comparable-content check in the writer already prevents an unchanged
            // listing from producing a notification at all.
            await this.reload().catch((err) => Logger.error("[ModelRegistry] Debounced reload failed:", err))
            // Notify all registered callbacks
            this.onChangeCallbacks.forEach((cb) => cb())
        }, 500)
    }

    /** Stop the file watcher and clear state. */
    async dispose(): Promise<void> {
        if (this.watcher) {
            this.watcher.close()
            this.watcher = null
        }
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer)
            this.reloadTimer = null
        }
        this.cache.clear()
        this.initialized = false
        this.deferredProvidersPromise = null
        this.onChangeCallbacks = []
    }

    /**
     * Get the configuration of a selectable provider.
     *
     * A catalog key that belongs to another provider's alternative catalog is
     * resolved to that provider, so a caller holding only a key still reaches the
     * entry that owns base URL, billing and display identity.
     */
    getProviderModels(providerId: string): ProviderModelsConfig | undefined {
        if (providerId === "openai") {
            return this.getUnifiedOpenAiConfig()
        }
        const direct = this.cache.get(providerId)
        if (direct) return direct
        // An alternative catalog key resolves to its owner, but only when that
        // owner is already loaded: answering from the seed would let a deferred
        // catalog look available before startup finished loading it. A primary
        // catalog key that is not the provider id resolves back to that id first,
        // because the cached entry is always stored under the provider identity.
        const ownerId = getProviderCatalog(providerId)?.provider.provider
        return ownerId ? this.cache.get(ownerId) : undefined
    }

    /**
     * Get the model catalog a catalog key selects.
     *
     * Unlike {@link getProviderModels} this answers with the catalog the key
     * names, which for an alternative catalog is not the provider's primary one.
     */
    getProviderCatalog(catalogKey: string): ProviderModelsConfig | undefined {
        const provider = this.getProviderModels(catalogKey)
        if (!provider) return undefined
        const selection = getProviderCatalog(catalogKey)
        if (!selection) return provider
        const catalog = selection.catalog
        if (catalog === selection.provider) {
            return provider
        }
        // The stored lookups below address the catalog the key actually names, not
        // the caller's argument: a provider id resolves to its primary catalog,
        // which may carry a different key.
        const storedKey = selection.provider.provider === catalogKey ? catalogKey : resolvePrimaryCatalogKey(catalogKey)
        // The stored catalog is the authority for this projection: discovery
        // writes the vendor's own statement into it, marked `userDefined: false`,
        // and the seed only fills fields that entry leaves absent. A catalog whose
        // seed states nothing therefore reads back exactly what discovery wrote.
        const storedModels = provider.catalogs?.[storedKey]?.models
        const models = storedModels
            ? {
                  ...catalog.models,
                  ...Object.fromEntries(
                      Object.entries(storedModels).map(([modelId, storedModel]) => {
                          const seedModel = catalog.models[modelId]
                          // A model a person added is described by nothing but its
                          // own declaration, so the seed must not complete it.
                          if (!isListingDerivedModel(storedModel)) {
                              return [modelId, storedModel]
                          }
                          if (!seedModel) {
                              return [modelId, { ...storedModel, id: modelId }]
                          }
                          return [
                              modelId,
                              {
                                  ...seedModel,
                                  ...(storedModel.apiFormats ? { apiFormats: [...storedModel.apiFormats] } : {}),
                                  // The stored entry states this model whole,
                                  // including a declaration that only publishes a
                                  // support flag.
                                  capabilities: storedModel.capabilities ?? seedModel.capabilities,
                                  pricing: storedModel.pricing ?? seedModel.pricing,
                              },
                          ]
                      }),
                  ),
              }
            : catalog.models
        return {
            ...provider,
            models,
            // The stored catalog's default is a decision the listing wrote; the
            // seed default may name a model this catalog no longer contains.
            defaultModelId: provider.catalogs?.[storedKey]?.defaultModelId ?? catalog.defaultModelId ?? provider.defaultModelId,
            imageModels: catalog.imageModels ?? provider.imageModels,
            defaultImageModelId: catalog.defaultImageModelId ?? provider.defaultImageModelId,
        }
    }

    /** Resolve the canonical OpenAI provider config from memory, using the seed catalog only as a field fallback. */
    private getUnifiedOpenAiConfig(): ProviderModelsConfig | undefined {
        const configured = this.cache.get("openai")
        if (!configured) {
            return undefined
        }

        const seed = getProviderSeedConfig("openai")
        const models = {
            ...(seed?.models ?? {}),
            ...(configured?.models ?? {}),
        }
        return {
            ...(seed ?? configured),
            ...configured,
            provider: "openai",
            providerName: "OpenAI",
            billingMode: configured?.billingMode ?? seed?.billingMode ?? "token",
            models: Object.fromEntries(
                Object.entries(models).map(([modelId, model]) => [
                    modelId,
                    withRequiredServerTool(model, ServerTool.IMAGE_GENERATION),
                ]),
            ),
            defaultModelId: configured?.defaultModelId ?? seed?.defaultModelId,
            imageModels: {
                ...(seed?.imageModels ?? {}),
                ...(configured?.imageModels ?? {}),
            },
            defaultImageModelId: configured?.defaultImageModelId ?? seed?.defaultImageModelId,
        }
    }

    /**
     * Get all loaded provider model configurations.
     */
    getAllProviders(): ProviderModelsConfig[] {
        const providers = Array.from(this.cache.entries())
            .filter(([providerId]) => providerId !== "openai")
            .map(([, config]) => config)
        const openai = this.getUnifiedOpenAiConfig()
        if (openai) providers.push(openai)
        return providers
    }

    /**
     * Get all loaded model catalogs, keyed by the primary or alternative catalog ID.
     */
    getAllModels(): Array<{
        provider: string
        providerName: string
        models: ModelInfo[]
        defaultModelId?: string
        imageModels: ImageModelInfo[]
        defaultImageModelId?: string
    }> {
        const result: Array<{
            provider: string
            providerName: string
            models: ModelInfo[]
            defaultModelId?: string
            imageModels: ImageModelInfo[]
            defaultImageModelId?: string
        }> = []

        for (const config of this.getAllProviders()) {
            const catalogKeys = getProviderCatalogKeys(getProviderSeedConfig(config.provider) ?? config)
            for (const catalogKey of catalogKeys) {
                // Every catalog goes through `getProviderCatalog`, including the
                // primary one: the RPC it feeds and the runtime both read the same
                // projection, so a listing statement cannot differ between them.
                const catalog = this.getProviderCatalog(catalogKey)
                if (!catalog) continue
                result.push({
                    provider: catalogKey,
                    providerName: config.providerName,
                    models: Object.values(catalog.models),
                    defaultModelId: catalog.defaultModelId,
                    imageModels: Object.values(catalog.imageModels ?? {}),
                    defaultImageModelId: catalog.defaultImageModelId,
                })
            }
        }

        return result
    }

    /**
     * Check if a provider has any models configured.
     */
    hasProvider(providerId: string): boolean {
        return Object.keys(this.getProviderModels(providerId)?.models ?? {}).length > 0
    }
}
