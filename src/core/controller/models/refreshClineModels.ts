import { discoverProviderModels } from "@core/model-registry/remote/model-refresh"
import { ensureCacheDirectoryExists, GlobalFileNames } from "@core/storage/disk"
import type { ModelInfo } from "@shared/api"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

const CLINE_PROVIDER_ID = "cline"

/**
 * Model list for the Cline provider, served by its own catalog endpoint.
 *
 * A rollout flag used to swap this source for the OpenRouter listing. The flag
 * and the OpenRouter branch are gone: the provider publishes its own catalog and
 * that is the only correct source for it.
 */
export async function refreshClineModels(_controller: Controller): Promise<Record<string, ModelInfo>> {
    const models = await discoverProviderModels(CLINE_PROVIDER_ID, undefined, { persist: true })
    if (Object.keys(models).length > 0) {
        return models
    }

    // Discovery already logged the failure; fall back to whatever the last
    // successful refresh left behind so the picker is not emptied by one
    // unreachable request.
    return (await readClineModelsFromCache()) ?? {}
}

/**
 * Reads a previously cached listing.
 *
 * The catalog itself is persisted by `discoverProviderModels`; this reads the
 * older cache file that earlier versions wrote, which is still the only copy
 * available on machines that have not refreshed since upgrading.
 */
export async function readClineModelsFromCache(): Promise<Record<string, ModelInfo> | undefined> {
    try {
        const filePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.clineModels)
        if (!(await fileExistsAtPath(filePath))) {
            return undefined
        }

        const fileContents = await fs.readFile(filePath, "utf8")
        return JSON.parse(fileContents)
    } catch (error) {
        Logger.error("Error reading cached Cline models:", error)
        return undefined
    }
}
