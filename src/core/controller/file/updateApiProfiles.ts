/**
 * Handler for updateApiProfiles RPC.
 *
 * Writes ApiProfile configurations to ~/.dline/data/settings/api_profiles.json.
 */

import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { OrchestratorController } from "@core/orchestrator/OrchestratorController"
import { getProfileCatalogRepository } from "@core/profiles/profile-catalog-runtime"
import {
    advanceProfileCatalogRevision,
    getProfileCatalogBaseline,
    recordProfileCatalogBaseline,
} from "@core/profiles/profile-catalog-state"
import { type ApiKeyEntry, getAllApiKeys, setApiKeysBatch } from "@core/storage/secrets"
import { Empty } from "@shared/proto/dline/common"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { UpdateApiProfilesRequest } from "@shared/proto/dline/profile"
import { Logger } from "@shared/services/Logger"
import type { Controller } from ".."
import { applyRegistryModelDefaults, normalizeApiProfile } from "./getApiProfiles"
import { reconcileOpenAiCodexProfileAuth } from "./openAiCodexProfileAuthLifecycle"

let updateApiProfilesQueue: Promise<Empty> = Promise.resolve(Empty.create({}))

/** Persist a Profile Catalog mutation without replacing a running Task handler. */
export async function updateApiProfiles(controller: Controller, request: UpdateApiProfilesRequest): Promise<Empty> {
    const nextUpdate = updateApiProfilesQueue.then(
        () => updateApiProfilesImpl(controller, request),
        () => updateApiProfilesImpl(controller, request),
    )
    updateApiProfilesQueue = nextUpdate.catch(() => Empty.create({}))
    return nextUpdate
}

function buildApiKeyChanges(
    previous: readonly ApiProfile[],
    profiles: readonly ApiProfile[],
    clearApiKeyProfileIds: ReadonlySet<string>,
): Record<string, ApiKeyEntry | undefined> {
    const nextIds = new Set(profiles.map((profile) => profile.id))
    const storedKeys = getAllApiKeys()
    const changes: Record<string, ApiKeyEntry | undefined> = {}

    for (const oldProfile of previous) {
        if (!nextIds.has(oldProfile.id)) changes[oldProfile.id] = undefined
    }
    for (const profile of profiles) {
        const stored = storedKeys[profile.id]
        if (clearApiKeyProfileIds.has(profile.id)) {
            profile.apiKey = ""
            if (stored) changes[profile.id] = undefined
        } else if (profile.apiKey) {
            if (!stored || stored.apiKey !== profile.apiKey || stored.name !== profile.name) {
                changes[profile.id] = { apiKey: profile.apiKey, name: profile.name }
            }
        } else if (stored && stored.name !== profile.name) {
            changes[profile.id] = { apiKey: stored.apiKey, name: profile.name }
        }
    }
    return changes
}

async function publishCommittedCatalog(controller: Controller, previous: ApiProfile[], profiles: ApiProfile[]): Promise<void> {
    recordProfileCatalogBaseline(controller, profiles)
    advanceProfileCatalogRevision()

    let orchestrator: OrchestratorController
    try {
        orchestrator = OrchestratorController.getInstance()
    } catch (error) {
        // Standalone controller tests and hosts may not initialize the orchestrator.
        Logger.warn("[updateApiProfiles] Profile change broadcast unavailable; updating current controller", error)
        await controller.postStateToWebview?.()
        return
    }

    await orchestrator.profileChanges.publish(previous, profiles)
}

async function updateApiProfilesImpl(controller: Controller, request: UpdateApiProfilesRequest): Promise<Empty> {
    const requested = (request.profiles || []).map(normalizeApiProfile)
    const registry = ModelRegistry.getInstance()
    if (!registry.isInitialized) await registry.reload()
    applyRegistryModelDefaults(requested)

    const repository = await getProfileCatalogRepository()
    const baseline = getProfileCatalogBaseline(controller) ?? (await repository.initialize())
    let previous: ApiProfile[]
    let profiles: ApiProfile[]
    try {
        const commit = await repository.mutate(baseline, requested)
        previous = commit.previous
        profiles = commit.profiles
    } catch (error) {
        Logger.error("[updateApiProfiles] Failed to commit Profile Catalog:", error)
        throw new Error("Failed to save Profile Catalog", { cause: error })
    }

    try {
        await reconcileOpenAiCodexProfileAuth(previous, profiles)
    } catch {
        await publishCommittedCatalog(controller, previous, profiles)
        Logger.error("[updateApiProfiles] Profile Catalog was saved but OpenAI Codex OAuth cleanup failed.")
        throw new Error("Profile Catalog was saved, but OpenAI Codex OAuth cleanup could not be completed")
    }

    const keyChanges = buildApiKeyChanges(previous, profiles, new Set(request.clearApiKeyProfileIds))
    try {
        await setApiKeysBatch(keyChanges)
    } catch (error) {
        await publishCommittedCatalog(controller, previous, profiles)
        Logger.error("[updateApiProfiles] Profile Catalog was saved but API key persistence failed:", error)
        throw new Error("Profile Catalog was saved, but API keys could not be persisted", { cause: error })
    }

    Logger.log(`[updateApiProfiles] Saved ${profiles.length} profile(s)`)
    await publishCommittedCatalog(controller, previous, profiles)
    return Empty.create({})
}
