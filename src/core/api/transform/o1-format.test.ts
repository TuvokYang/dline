import { describe, expect, it } from "vitest"
import { convertToO1Messages } from "./o1-format"

describe("convertToO1Messages", () => {
    it("uses the generated system prompt without embedding a private prompt layer", () => {
        const systemPrompt = "LITE PROFILE PROMPT"
        const messages = convertToO1Messages([{ role: "user", content: "hello" }], systemPrompt)

        expect(messages[0]).toEqual({ role: "user", content: systemPrompt })
        expect(JSON.stringify(messages)).not.toContain("Instructions for Formulating Your Response")
    })
})
