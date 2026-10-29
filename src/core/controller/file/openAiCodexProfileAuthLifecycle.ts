import type { ApiProfile } from "@shared/proto/dline/profile"
import { OpenAiCodexProfileAuthGarbageCollector } from "@/core/storage/secrets/OpenAiCodexProfileAuthGarbageCollector"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"

export interface OpenAiCodexProfileAuthLifecycleDependencies {
    clearCredentials(profileId: string): Promise<void>
    collectGarbage(profiles: readonly ApiProfile[]): Promise<unknown>
    migrateLegacyProfiles?(profiles: readonly ApiProfile[]): Promise<unknown>
}

function defaultDependencies(): OpenAiCodexProfileAuthLifecycleDependencies {
    const collector = new OpenAiCodexProfileAuthGarbageCollector({
        secretsDir: openAiCodexOAuthManager.sessions.repository.secretsDir,
    })
    return {
        clearCredentials: (profileId) => openAiCodexOAuthManager.clearCredentials(profileId),
        collectGarbage: (profiles) => collector.collect(profiles),
        migrateLegacyProfiles: (profiles) => openAiCodexOAuthManager.migrateLegacyCredentials(profiles),
    }
}

/** Reconcile OAuth ownership after a Profile Catalog commit. */
export async function reconcileOpenAiCodexProfileAuth(
    previous: readonly ApiProfile[],
    profiles: readonly ApiProfile[],
    dependencies: OpenAiCodexProfileAuthLifecycleDependencies = defaultDependencies(),
): Promise<void> {
    await dependencies.migrateLegacyProfiles?.(previous)

    const retainedCodexProfileIds = new Set(
        profiles.filter((profile) => profile.provider === "openai-codex").map((profile) => profile.id),
    )
    const removedCodexProfileIds = previous
        .filter((profile) => profile.provider === "openai-codex" && !retainedCodexProfileIds.has(profile.id))
        .map((profile) => profile.id)

    for (const profileId of removedCodexProfileIds) {
        await dependencies.clearCredentials(profileId)
    }
    await dependencies.collectGarbage(profiles)
    await dependencies.migrateLegacyProfiles?.(profiles)
}
