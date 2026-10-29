import type { ImageGenerationProfile } from "@shared/proto/dline/profile"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
    fileText: "[]",
    storedKeys: {} as Record<string, { apiKey: string; name: string }>,
    writtenText: "",
    changes: {} as Record<string, { apiKey: string; name: string } | undefined>,
}))

vi.mock("@core/storage/disk", () => ({ getDlineDataDir: () => "e:/dline-test" }))
vi.mock("node:fs", () => ({
    default: { readFileSync: () => state.fileText },
}))
vi.mock("@shared/storage/atomic-file", () => ({
    writeFileAtomic: vi.fn(async (_path: string, text: string) => {
        state.writtenText = text
    }),
}))
vi.mock("@core/storage/secrets", () => ({
    getAllApiKeys: () => state.storedKeys,
    getApiKey: (id: string) => state.storedKeys[id]?.apiKey,
    setApiKeysBatch: vi.fn(async (changes: typeof state.changes) => {
        state.changes = changes
    }),
}))

import {
    imageGenerationProfileSecretId,
    projectImageGenerationProfilesForUi,
    readImageGenerationProfiles,
    serializeImageGenerationProfiles,
    updateImageGenerationProfileCatalog,
} from "./imageGenerationProfiles"

const profile = {
    id: "image-profile-1",
    name: "Custom Images",
    provider: "openai",
    baseUrl: "https://images.example.test/v1",
    apiKey: "sk-image-secret",
    enabled: true,
    legacyNames: [],
} as ImageGenerationProfile

describe("imageGenerationProfiles", () => {
    beforeEach(() => {
        state.fileText = "[]"
        state.storedKeys = {}
        state.writtenText = ""
        state.changes = {}
    })

    it("serializes connection metadata without API keys", () => {
        const serialized = JSON.stringify(serializeImageGenerationProfiles([profile]))
        expect(serialized).not.toContain(profile.apiKey)
        expect(serialized).not.toContain("apiKey")
    })

    it("hydrates the namespaced API key only when reading", () => {
        state.fileText = JSON.stringify([{ ...profile, apiKey: undefined }])
        state.storedKeys[imageGenerationProfileSecretId(profile.id)] = { apiKey: profile.apiKey, name: profile.name }
        expect(readImageGenerationProfiles()).toEqual([expect.objectContaining({ ...profile })])
    })

    it("never returns hydrated API keys in the Webview projection", () => {
        const projected = projectImageGenerationProfilesForUi([profile])
        expect(projected).toEqual([expect.objectContaining({ id: profile.id, apiKey: "" })])
        expect(JSON.stringify(projected)).not.toContain(profile.apiKey)
    })

    it("writes secrets separately and clears removed or explicitly cleared keys", async () => {
        state.fileText = JSON.stringify([
            { id: "removed", name: "Removed", provider: "openai", enabled: true, legacyNames: [] },
            { ...profile, apiKey: undefined },
        ])
        state.storedKeys = {
            "image:removed": { apiKey: "removed-secret", name: "Removed" },
            [imageGenerationProfileSecretId(profile.id)]: { apiKey: "old-secret", name: profile.name },
        }

        await updateImageGenerationProfileCatalog({ profiles: [profile], clearApiKeyProfileIds: [profile.id] })

        expect(state.changes).toEqual({ "image:removed": undefined, [imageGenerationProfileSecretId(profile.id)]: undefined })
        expect(state.writtenText).not.toContain("secret")
        expect(state.writtenText).not.toContain("apiKey")
    })
})
