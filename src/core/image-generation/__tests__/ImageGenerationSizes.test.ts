import { GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID } from "@shared/image-generation"
import { describe, expect, it } from "vitest"
import { resolveOpenAIImageSize, resolveOpenAISubscriptionImagePrompt } from "../ImageGenerationSizes"

describe("resolveOpenAIImageSize", () => {
    it("uses 2048x1152 by default and preserves valid GPT Image 2 flexible sizes", () => {
        expect(resolveOpenAIImageSize("gpt-image-2")).toBe("2048x1152")
        expect(resolveOpenAIImageSize("gpt-image-2", { width: 1536, height: 864 })).toBe("1536x864")
        expect(resolveOpenAIImageSize("gpt-image-2", { width: 2160, height: 3840 })).toBe("2160x3840")
    })

    it("maps arbitrary requested dimensions to GPT Image 1 supported aspect presets", () => {
        expect(resolveOpenAIImageSize("gpt-image-1")).toBe("1536x1024")
        expect(resolveOpenAIImageSize("gpt-image-1", { width: 1024, height: 1024 })).toBe("1024x1024")
        expect(resolveOpenAIImageSize("gpt-image-1", { width: 720, height: 1280 })).toBe("1024x1536")
    })

    it.each([
        { width: 1920, height: 1080 },
        { width: 640, height: 480 },
        { width: 3840, height: 2176 },
        { width: 3088, height: 1024 },
        { width: 3840, height: 3840 },
    ])("rejects invalid official GPT Image 2 API size $width×$height", ({ width, height }) => {
        expect(() => resolveOpenAIImageSize("gpt-image-2", { width, height })).toThrow(/GPT Image 2 dimensions/)
    })

    it.each([
        ["16:9", { width: 2048, height: 1152 }, "横版 16:9", { width: 1672, height: 941 }],
        ["9:16", { width: 1152, height: 2048 }, "竖屏 9:16", { width: 941, height: 1672 }],
        ["4:3", { width: 1440, height: 1080 }, "4:3", { width: 1448, height: 1086 }],
        ["3:4", { width: 1080, height: 1440 }, "3:4", { width: 1086, height: 1448 }],
        ["3:2", { width: 1500, height: 1000 }, "3:2 尺寸", { width: 1536, height: 1024 }],
        ["2:3", { width: 1000, height: 1500 }, "2:3 尺寸", { width: 1024, height: 1536 }],
        ["2:5", { width: 800, height: 2000 }, "2:5 竖屏", { width: 793, height: 1983 }],
        ["5:2", { width: 2000, height: 800 }, "5:2 横屏", { width: 1983, height: 793 }],
    ] as const)("maps subscription ratio %s to its verbatim prompt phrase and verified output", (_, size, phrase, outputSize) => {
        expect(resolveOpenAIImageSize(GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID, size)).toBeUndefined()
        expect(resolveOpenAISubscriptionImagePrompt("A blue owl", size)).toEqual({
            prompt: `A blue owl\n\n${phrase}`,
            expectedOutputSize: outputSize,
        })
    })
})
