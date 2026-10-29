import type { ApiHandler } from "@core/api"
import { OpenAiHandler } from "@core/api/providers/openai"
import { describe, expect, it } from "vitest"
import { getContextWindowInfo } from "./context-window-utils"

describe("getContextWindowInfo", () => {
    it("preserves an explicit OpenAI-compatible context window for DeepSeek model IDs", () => {
        const api = Object.assign(Object.create(OpenAiHandler.prototype), {
            getModel: () => ({
                id: "custom-deepseek-model",
                info: { capabilities: { contextWindow: 256_000 } },
            }),
        }) as ApiHandler

        expect(getContextWindowInfo(api)).toEqual({
            contextWindow: 256_000,
            maxAllowedSize: 216_000,
        })
    })
})
