import type { ModelInfo } from "@shared/proto/dline/models"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { supportsBrowserUse } from "./pricingUtils"

describe("supportsBrowserUse", () => {
    it.each([
        { images: false, browser: undefined, expected: false },
        { images: true, browser: undefined, expected: true },
        { images: true, browser: false, expected: false },
        { images: false, browser: true, expected: true },
        { images: undefined, browser: undefined, expected: false },
    ])("matches the request-side browser capability instead of hosted Search: %j", ({ images, browser, expected }) => {
        const model: ModelInfo = {
            id: "browser-model",
            capabilities: { supportsImages: images, supportsBrowserAction: browser, tools: [ServerTool.WEB_SEARCH] },
        }
        expect(supportsBrowserUse(model)).toBe(expected)
    })
})
