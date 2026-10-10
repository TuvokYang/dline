import { openAiModels } from "@shared/api"
import { allProviderModels } from "@shared/providers/model-infos"
import { PROVIDER_OPTIONS } from "@shared/providers/providers"
import { describe, expect, it } from "vitest"

describe("OpenAI provider consolidation", () => {
    it("exposes one API-key OpenAI provider with the official model catalog", () => {
        const apiKeyProviders = PROVIDER_OPTIONS.filter(({ value }) => value === "openai")

        expect(apiKeyProviders).toEqual([{ value: "openai", label: "OpenAI" }])
        expect(allProviderModels.openai.models).toEqual(openAiModels)
        // `openai-native` was merged into `openai`. Compare as plain strings: the
        // option type no longer admits the retired id, so a typed comparison would
        // be rejected at compile time instead of guarding against a regression.
        expect(PROVIDER_OPTIONS.some(({ value }) => (value as string) === "openai-native")).to.equal(false)
    })
})
