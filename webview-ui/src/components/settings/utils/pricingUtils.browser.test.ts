import type { ModelInfo } from "@shared/proto/dline/models"
import { describe, expect, it } from "vitest"
import { supportsBrowserUse } from "./pricingUtils"

describe("supportsBrowserUse", () => {
    it("does not require image input when the model exposes a server web tool", () => {
        const model = {
            id: "text-only-web-model",
            capabilities: { supportsImages: false, tools: ["web_search"] },
        } as unknown as ModelInfo

        expect(supportsBrowserUse(model)).toBe(true)
    })
})
