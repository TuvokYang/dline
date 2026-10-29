import type { StateManager } from "@core/storage/StateManager"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { type ApiProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    readApiProfiles: vi.fn(),
    readImageGenerationProfiles: vi.fn(() => []),
    getProviderModels: vi.fn(),
}))

vi.mock("@core/controller/file/getApiProfiles", () => ({ readApiProfiles: mocks.readApiProfiles }))
vi.mock("@core/controller/file/imageGenerationProfiles", () => ({
    readImageGenerationProfiles: mocks.readImageGenerationProfiles,
}))
vi.mock("@core/model-registry/ModelRegistry", () => ({
    ModelRegistry: {
        getInstance: () => ({ getProviderModels: mocks.getProviderModels }),
    },
}))

import { createImageProfileResolver, createImageProfileResolverForProfile, hasAvailableImageProfile } from "../runtime"

const taskProfile = {
    id: "task-profile",
    name: "Task Profile",
    provider: "openai",
    modelId: "custom-responses-model",
    imageModelId: "gpt-image-2",
    imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION,
    openai: { apiFormat: ApiFormat.OPENAI_RESPONSES },
    usedFor: ["act"],
    enabled: true,
} as ApiProfile

const cursorProfile = {
    ...taskProfile,
    id: "cursor-profile",
    name: "Cursor Profile",
    imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED,
    imageModelId: undefined,
} as ApiProfile

function createStateManager(canonicalEnabled: boolean): StateManager {
    return {
        getApiConfigurationForTask: vi.fn((taskId: string) => {
            expect(taskId).toBe("task-a")
            return {
                actModeProfileId: taskProfile.id,
                actModeProfile: taskProfile.name,
                planModeProfileId: cursorProfile.id,
                planModeProfile: cursorProfile.name,
            }
        }),
        getApiConfiguration: vi.fn(() => ({
            actModeProfileId: cursorProfile.id,
            actModeProfile: cursorProfile.name,
        })),
        getCanonicalSettingsKey: vi.fn((key: string) => (key === "imageGenerationEnabled" ? canonicalEnabled : undefined)),
        getGlobalSettingsKey: vi.fn((key: string) => {
            if (key === "imageGenerationEnabled") return !canonicalEnabled
            if (key === "mode") return "act"
            return undefined
        }),
    } as unknown as StateManager
}

describe("image generation runtime binding", () => {
    beforeEach(() => {
        mocks.readApiProfiles.mockReset()
        mocks.readImageGenerationProfiles.mockClear()
        mocks.getProviderModels.mockReset()
        mocks.readApiProfiles.mockReturnValue([taskProfile, cursorProfile])
        mocks.getProviderModels.mockReturnValue({
            defaultImageModelId: "gpt-image-2",
            imageModels: {
                "gpt-image-2": {
                    id: "gpt-image-2",
                    capabilities: { supportsGeneration: true, supportsEditing: true },
                },
            },
        })
    })

    it("resolves the explicit Task Profile without consulting the shared active-task cursor", () => {
        const stateManager = createStateManager(true)
        const binding = { taskId: "task-a", getCurrentMode: () => "act" as const }

        expect(hasAvailableImageProfile(stateManager, binding)).toBe(true)
        expect(createImageProfileResolver(stateManager, binding).resolve().profile.id).toBe(taskProfile.id)
        expect(stateManager.getApiConfigurationForTask).toHaveBeenCalledWith("task-a")
        expect(stateManager.getApiConfiguration).not.toHaveBeenCalled()
        expect(stateManager.getGlobalSettingsKey).not.toHaveBeenCalled()
    })

    it("resolves a fixed subagent Profile without consulting any Task cursor", () => {
        const resolver = createImageProfileResolverForProfile({
            profileId: taskProfile.id,
            profileName: taskProfile.name,
        })

        expect(resolver.hasAvailableProfile()).toBe(true)
        expect(resolver.resolve().profile.id).toBe(taskProfile.id)
    })

    it("uses the canonical global feature gate instead of a Task-overridable settings value", () => {
        const stateManager = createStateManager(false)

        expect(hasAvailableImageProfile(stateManager, { taskId: "task-a", getCurrentMode: () => "act" })).toBe(false)
        expect(stateManager.getCanonicalSettingsKey).toHaveBeenCalledWith("imageGenerationEnabled")
        expect(stateManager.getGlobalSettingsKey).not.toHaveBeenCalled()
    })
})
