/**
 * Seed initializer — exports built-in provider model data to ~/.dline/providers/
 * on first run, so users have a complete set of model configurations to work with.
 *
 * Existing built-in models are refreshed from current metadata. Models marked
 * userDefined, and models unknown to the current seed, are preserved.
 */
import { allProviderModels } from "@shared/providers/model-infos"
import type { ProviderModelsConfig } from "@shared/providers/types"
import { Logger } from "@shared/services/Logger"
import fs from "fs"
import fsPromises from "fs/promises"
import * as path from "path"
import { isDeferredProvider } from "./provider-catalog-policy"
import { getLegacyProviderConfigFileNames, getProviderConfigFileName } from "./provider-config-file"
import { markBuiltInModels, reconcileProviderModels } from "./provider-model-reconciliation"

/**
 * Ensure that ~/.dline/providers/ contains a JSON file for every provider
 * defined in allProviderModels. Missing files are created and existing model
 * catalogs are reconciled with the current seed data.
 *
 * This is safe to call on every startup: only unmarked built-in models are refreshed.
 *
 * @param providersDir Absolute path to the providers directory
 * @returns Number of newly created seed files
 */
export async function ensureSeedProviders(providersDir: string): Promise<number> {
    let created = 0

    // Ensure the providers directory exists
    await fsPromises.mkdir(providersDir, { recursive: true })

    for (const [providerId, config] of Object.entries(allProviderModels)) {
        const filePath = path.join(providersDir, getProviderConfigFileName(providerId))
        const existingFilePath = [
            filePath,
            ...getLegacyProviderConfigFileNames(providerId).map((name) => path.join(providersDir, name)),
        ].find((candidate) => fs.existsSync(candidate))

        if (isDeferredProvider(providerId)) {
            if (!existingFilePath) {
                try {
                    await fsPromises.writeFile(filePath, serializeConfig(markBuiltInModels(config)), "utf8")
                    created++
                    Logger.log(`[seed-initializer] Created deferred provider config: ${path.basename(filePath)}`)
                } catch (err) {
                    Logger.warn(`[seed-initializer] Failed to create deferred provider config for ${providerId}:`, err)
                }
            }
            continue
        }

        // Refresh built-ins while preserving explicitly marked and unknown user models.
        if (existingFilePath) {
            try {
                const stored = JSON.parse(await fsPromises.readFile(existingFilePath, "utf8")) as ProviderModelsConfig
                const reconciled = reconcileProviderModels(config, stored, "refresh-built-ins")
                if (existingFilePath !== filePath || serializeConfig(reconciled) !== serializeConfig(stored)) {
                    await fsPromises.writeFile(filePath, serializeConfig(reconciled), "utf8")
                    Logger.log(`[seed-initializer] Refreshed built-in models: ${path.basename(filePath)}`)
                }
            } catch (err) {
                Logger.warn(`[seed-initializer] Failed to refresh seed config for ${providerId}:`, err)
            }
            continue
        }

        try {
            // Convert the config to a clean JSON-serializable object
            const jsonContent = serializeConfig(markBuiltInModels(config))
            await fsPromises.writeFile(filePath, jsonContent, "utf8")
            created++
            Logger.log(`[seed-initializer] Created seed config: ${providerId}.json (${Object.keys(config.models).length} models)`)
        } catch (err) {
            Logger.warn(`[seed-initializer] Failed to create seed config for ${providerId}:`, err)
        }
    }

    if (created > 0) {
        Logger.log(`[seed-initializer] Created ${created} seed provider config(s) in ${providersDir}`)
    }

    return created
}

/**
 * Serialize a ProviderModelsConfig to formatted JSON string.
 */
function serializeConfig(config: ProviderModelsConfig): string {
    return `${JSON.stringify(config, null, "\t")}\n`
}
