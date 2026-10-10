/**
 * ModelRegistry — central service for provider model configuration.
 *
 * Loads provider model configs from ~/.dline/providers/*.json,
 * caches them in memory, and watches for file changes.
 */
import { getDlineHomePath } from "@core/storage/disk"
import { ServerTool, serverToolFromJSON } from "@shared/proto/dline/models/metadata"
import { getProviderSeedConfig } from "@shared/providers/model-infos"
import type { ImageModelInfo, ModelInfo, ProviderModelsConfig } from "@shared/providers/types"
import { Logger } from "@shared/services/Logger"
import chokidar, { type FSWatcher } from "chokidar"
import fs from "fs/promises"
import * as path from "path"
import { DEFERRED_PROVIDER_IDS } from "./provider-catalog-policy"
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
    return enrichMissingSeedMetadata(config.provider || providerId, config)
}

export class ModelRegistry {
    private static instance?: ModelRegistry
    private cache = new Map<string, ProviderModelsConfig>()
    private watcher: FSWatcher | null = null
    private initialized = false
    private onChangeCallbacks: Array<() => void> = []
    private deferredProvidersPromise: Promise<void> | null = null
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
     * Reload all provider configs from disk.
     */
    async reload(options?: {
        includeProviderIds?: ReadonlySet<string>
        excludeProviderIds?: ReadonlySet<string>
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
            const loadedConfigs = new Map<string, { config: ProviderModelsConfig; fileName: string }>()

            for (const fileName of jsonFiles) {
                const fileProviderId = getProviderIdFromConfigFile(fileName)
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

            this._version++
            Logger.debug(`[ModelRegistry] Reloaded ${this.cache.size} provider(s)`)
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
            this.watcher.on("add", () => this.debouncedReload())
            this.watcher.on("change", () => this.debouncedReload())
            this.watcher.on("unlink", () => this.debouncedReload())
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

    private debouncedReload(): void {
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(async () => {
            this.reloadTimer = null
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
     * Get models for a specific provider.
     */
    getProviderModels(providerId: string): ProviderModelsConfig | undefined {
        if (providerId === "openai") {
            return this.getUnifiedOpenAiConfig()
        }
        return this.cache.get(providerId)
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
     * Get all models across all providers, grouped by provider.
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
            result.push({
                provider: config.provider,
                providerName: config.providerName,
                models: Object.values(config.models),
                defaultModelId: config.defaultModelId,
                imageModels: Object.values(config.imageModels ?? {}),
                defaultImageModelId: config.defaultImageModelId,
            })
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
