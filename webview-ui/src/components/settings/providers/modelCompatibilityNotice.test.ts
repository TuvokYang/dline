import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { getModelCompatibilityNotice } from "./modelCompatibilityNotice"

function capabilities(values: Partial<ModelCapabilities>): ModelCapabilities {
    return values as ModelCapabilities
}

describe("getModelCompatibilityNotice", () => {
    it("returns no notice when prompt-relevant metadata is complete", () => {
        expect(
            getModelCompatibilityNotice({
                capabilities: capabilities({ contextWindow: 128_000, supportsTools: true }),
            }),
        ).toBeUndefined()
    })

    it("reports Lite prompt selection for a known context window below 64K", () => {
        expect(
            getModelCompatibilityNotice({
                capabilities: capabilities({ contextWindow: 32_768 }),
            }),
        ).toEqual({
            reason: "lite_prompt",
            variant: "info",
            title: "Lite prompt profile",
            message: "This model uses the Lite prompt profile because its context window is below 64K tokens.",
        })
    })

    it.each([
        capabilities({ supportsTools: true }),
        capabilities({ contextWindow: 128_000 }),
        capabilities({ contextWindow: 0, supportsTools: true }),
    ])("reports incomplete metadata when context window or native tool support is unknown", (modelCapabilities) => {
        expect(getModelCompatibilityNotice({ capabilities: modelCapabilities })).toEqual({
            reason: "unknown_metadata",
            variant: "info",
            title: "Model metadata incomplete",
            message:
                "Confirm the context window and native tool support for this model to improve prompt selection and feature availability.",
        })
    })

    it("treats explicit lack of native tool support as known metadata", () => {
        expect(
            getModelCompatibilityNotice({
                capabilities: capabilities({ contextWindow: 128_000, supportsTools: false }),
            }),
        ).toBeUndefined()
    })
})
