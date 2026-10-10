import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import type { ClineContent, ClineStorageMessage } from "@/shared/messages"
import { ensureApiMessages, ensureUserContent } from "../api-context"

/**
 * Build a minimal user message for API context tests.
 * @param text Text content for the message.
 * @returns A storage message with user role.
 */
function userMessage(text: string): ClineStorageMessage {
    return { role: "user", content: [{ type: "text", text }] } as ClineStorageMessage
}

describe("ensureApiMessages", () => {
    it("uses fallback history when context manager returns empty messages", () => {
        const fallback = [userMessage("recover from process anyway")]

        const result = ensureApiMessages([], fallback)

        assert.deepEqual(result, fallback)
    })

    /**
     * Build user content with a single text block.
     * @param text Text payload for the content block.
     * @returns User content array.
     */
    function textContent(text: string): ClineContent[] {
        return [{ type: "text", text }] as ClineContent[]
    }

    describe("ensureUserContent", () => {
        it("throws when user content is empty", () => {
            assert.throws(() => ensureUserContent([], "auto compact request"), /Refusing to send empty user content/)
        })

        it("throws when user content contains only blank text", () => {
            assert.throws(() => ensureUserContent(textContent("   \n\t"), "auto compact request"), /auto compact request/)
        })

        it("returns non-empty user content unchanged", () => {
            const content = textContent("summarize this conversation")

            const result = ensureUserContent(content, "auto compact request")

            assert.deepEqual(result, content)
        })
    })

    it("throws a clear error when both managed and fallback histories are empty", () => {
        assert.throws(() => ensureApiMessages([], []), /Refusing to send an empty API conversation/)
    })
})
