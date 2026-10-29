import { basetenModels, groqModels } from "@shared/api"
import { expect } from "chai"
import { describe, it } from "vitest"
import { resolveBasetenSupportsTools } from "../refreshBasetenModels"
import { resolveGroqSupportsTools } from "../refreshGroqModels"

describe("dynamic provider native-tool capabilities", () => {
    it("maps Baseten supported_features and falls back only to explicit static metadata", () => {
        const staticModel = basetenModels["moonshotai/Kimi-K2-Thinking"]

        expect(resolveBasetenSupportsTools({ supported_features: ["tools"] })).to.equal(true)
        expect(resolveBasetenSupportsTools({ supported_features: [] }, staticModel)).to.equal(false)
        expect(resolveBasetenSupportsTools({}, staticModel)).to.equal(true)
        expect(resolveBasetenSupportsTools({}, undefined)).to.equal(undefined)
    })

    it("maps Groq structured feature metadata and falls back only to explicit static metadata", () => {
        const staticModel = groqModels["llama-3.3-70b-versatile"]

        expect(resolveGroqSupportsTools({ supportedFeatures: { tools: true } })).to.equal(true)
        expect(resolveGroqSupportsTools({ supported_features: { tools: false } }, staticModel)).to.equal(false)
        expect(resolveGroqSupportsTools({}, staticModel)).to.equal(true)
        expect(resolveGroqSupportsTools({}, undefined)).to.equal(undefined)
    })
})
