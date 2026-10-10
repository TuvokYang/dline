import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it, vi } from "vitest"
import { reconcileOpenAiCodexProfileAuth } from "./openAiCodexProfileAuthLifecycle"

function profile(id: string, provider: string, name = id, modelId = "model-a"): ApiProfile {
    return ApiProfile.create({ id, provider, name, modelId, enabled: true })
}

describe("reconcileOpenAiCodexProfileAuth", () => {
    it("clears only Codex Profiles that were deleted or switched to another Provider", async () => {
        const clearCredentials = vi.fn().mockResolvedValue(undefined)
        const collect = vi.fn().mockResolvedValue({ deletedFileNames: [] })
        const migrate = vi.fn().mockResolvedValue({ status: "missing-legacy" })
        const previous = [
            profile("kept", "openai-codex"),
            profile("deleted", "openai-codex"),
            profile("switched", "openai-codex"),
        ]
        const next = [profile("kept", "openai-codex"), profile("switched", "anthropic")]

        await reconcileOpenAiCodexProfileAuth(previous, next, {
            clearCredentials,
            collectGarbage: collect,
            migrateLegacyProfiles: migrate,
        })

        expect(migrate).toHaveBeenNthCalledWith(1, previous)
        expect(clearCredentials.mock.calls.map(([id]) => id).sort()).toEqual(["deleted", "switched"])
        expect(collect).toHaveBeenCalledWith(next)
        expect(migrate).toHaveBeenNthCalledWith(2, next)
    })

    it("preserves credentials for rename, model, reasoning and enabled edits", async () => {
        const clearCredentials = vi.fn().mockResolvedValue(undefined)
        const collect = vi.fn().mockResolvedValue({ deletedFileNames: [] })
        const previous = [profile("kept", "openai-codex", "Before", "model-a")]
        const next = [
            ApiProfile.create({
                ...profile("kept", "openai-codex", "After", "model-b"),
                enabled: false,
                openaiCodex: { reasoning: { effort: "high" } },
            }),
        ]

        await reconcileOpenAiCodexProfileAuth(previous, next, {
            clearCredentials,
            collectGarbage: collect,
        })

        expect(clearCredentials).not.toHaveBeenCalled()
        expect(collect).toHaveBeenCalledWith(next)
    })

    it("does not copy or create a credential when a Codex Profile is duplicated", async () => {
        const clearCredentials = vi.fn().mockResolvedValue(undefined)
        const collect = vi.fn().mockResolvedValue({ deletedFileNames: [] })
        const previous = [profile("source", "openai-codex")]
        const next = [profile("source", "openai-codex"), profile("duplicate", "openai-codex")]

        await reconcileOpenAiCodexProfileAuth(previous, next, {
            clearCredentials,
            collectGarbage: collect,
        })

        expect(clearCredentials).not.toHaveBeenCalled()
        expect(collect).toHaveBeenCalledWith(next)
    })
})
