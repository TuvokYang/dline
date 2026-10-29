import { deepSeekModels } from "@core/api/providers/models/deepseek"
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { ApiProfile } from "@shared/proto/dline/profile"
import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { resolveInputMediaTypes } from "@shared/providers/input-media"
import { expect } from "chai"
import { afterEach, describe, it, vi } from "vitest"
import { getProfileModelInfo } from "../model-info"

describe("getProfileModelInfo", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("resolves provider registry metadata when top-level modelInfo is absent", () => {
        vi.spyOn(ModelRegistry, "getInstance").mockReturnValue({
            getProviderModels: () => ({
                provider: "deepseek",
                providerName: "DeepSeek",
                billingMode: "token",
                models: deepSeekModels,
                defaultModelId: "deepseek-v4-pro",
            }),
        } as unknown as ModelRegistry)
        const profile = ApiProfile.create({
            provider: "deepseek",
            modelId: "deepseek-v4-pro",
            deepseek: BaseProviderConfig.create(),
        })

        const result = getProfileModelInfo(profile)

        expect(result.id).to.equal("deepseek-v4-pro")
        expect(result.capabilities?.contextWindow).to.equal(1_000_000)
    })

    // deepseek-flash reads images while deepseek-v4-pro does not, so the declared
    // capability must reach the media resolver for one model and not the other.
    it("declares image input for deepseek-flash only", () => {
        vi.spyOn(ModelRegistry, "getInstance").mockReturnValue({
            getProviderModels: () => ({
                provider: "deepseek",
                providerName: "DeepSeek",
                billingMode: "token",
                models: deepSeekModels,
                defaultModelId: "deepseek-flash",
            }),
        } as unknown as ModelRegistry)

        const resolve = (modelId: string) =>
            resolveInputMediaTypes(
                getProfileModelInfo(ApiProfile.create({ provider: "deepseek", modelId, deepseek: BaseProviderConfig.create() })),
            )

        expect(resolve("deepseek-flash").has("image/png")).to.equal(true)
        expect(resolve("deepseek-v4-pro").has("image/png")).to.equal(false)
    })
})
