import should from "should"
import { describe, it } from "vitest"
import { combineHookSequences } from "./combineHookSequences"
import type { UiMessage } from "./ExtensionMessage"

describe("combineHookSequences", () => {
    it("keeps partial tool messages when no newer tool message with same timestamp exists", () => {
        const messages: UiMessage[] = [
            {
                ts: 1,
                type: "say",
                say: "reasoning",
                text: "thinking...",
                partial: true,
            },
            {
                ts: 2,
                type: "say",
                say: "tool",
                text: '{"tool":"editedExistingFile","path":"README.md","content":"partial"}',
                partial: true,
            },
        ]

        const result = combineHookSequences(messages)
        const streamedTool = result.find((msg) => msg.ts === 2)

        should(streamedTool).not.be.undefined()
        if (!streamedTool) {
            throw new Error("Expected streamed tool message to be present")
        }
        should(streamedTool.partial).equal(true)
        should(streamedTool.say).equal("tool")
    })

    it("keeps only the newest tool message variant for a shared timestamp", () => {
        const messages: UiMessage[] = [
            {
                ts: 10,
                type: "ask",
                ask: "tool",
                text: '{"tool":"editedExistingFile","path":"README.md","content":"partial"}',
                partial: true,
            },
            {
                ts: 10,
                type: "ask",
                ask: "tool",
                text: '{"tool":"editedExistingFile","path":"README.md","content":"final"}',
                partial: false,
            },
        ]

        const result = combineHookSequences(messages)
        const sameTsMessages = result.filter((msg) => msg.ts === 10)

        sameTsMessages.should.have.length(1)
        const finalMessage = sameTsMessages.at(0)
        if (!finalMessage) {
            throw new Error("Expected a final tool message")
        }
        should(finalMessage.partial).equal(false)
        should(finalMessage.text).equal('{"tool":"editedExistingFile","path":"README.md","content":"final"}')
    })
})
