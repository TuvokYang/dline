import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { resolveChatRestoreBoundary } from "../chat-restore-boundary"

/**
 * P0 regression guard for
 * "Restore API boundary is outside the current conversation".
 *
 * A failed compaction card is anchored to the last assistant message of an
 * unfinished round, so it has no successor user message. The ordinary
 * `conversationHistoryIndex + 2` arithmetic then runs one past the end of the
 * conversation and rejected an otherwise legitimate chat restore.
 */

function failedCompactionCard(conversationHistoryIndex: number, ts: number): UiMessage {
    return {
        ts,
        type: "say",
        say: "tool",
        partial: false,
        conversationHistoryIndex,
        text: JSON.stringify({
            tool: "summarizeTask",
            content: "",
            compactionStatus: "failed",
            error: "400 No tool output found for function call fc_ClqKYdfhn2EQ96FhGa6slahO.",
        }),
    } as UiMessage
}

function userMessage(ts: number, conversationHistoryIndex: number): UiMessage {
    return { ts, type: "say", say: "text", text: "user turn", conversationHistoryIndex } as UiMessage
}

describe("chat restore boundary for a failed compaction card", () => {
    it("restores a failed compaction card anchored to the final assistant message", () => {
        // Mirrors task 1787923017605: the failed card reports conversationHistoryIndex 340
        // while the conversation holds 341 messages (indexes 0..340).
        const messages = [userMessage(1, 338), failedCompactionCard(340, 2)]

        const boundary = resolveChatRestoreBoundary({
            messages,
            messageIndex: 1,
            apiCount: 341,
            uiCount: messages.length,
        })

        // The whole conversation is kept: there is no successor user message to drop.
        expect(boundary.apiKeepCount).toBe(341)
        expect(boundary.runtimeApiIndex).toBe(340)
        expect(boundary.uiKeepCount).toBe(2)
        expect(boundary.contextAnchorTs).toBe(2)
    })

    it("keeps the ordinary successor-user-message boundary intact", () => {
        // An ordinary card points at its assistant message, so the following user
        // message is still part of the restored round.
        const messages = [userMessage(1, 0), userMessage(2, 2)]

        const boundary = resolveChatRestoreBoundary({
            messages,
            messageIndex: 1,
            apiCount: 10,
            uiCount: messages.length,
        })

        expect(boundary.apiKeepCount).toBe(4)
        expect(boundary.runtimeApiIndex).toBe(3)
    })

    it("still rejects a boundary genuinely beyond the conversation", () => {
        const messages = [userMessage(1, 0), failedCompactionCard(999, 2)]

        expect(() =>
            resolveChatRestoreBoundary({
                messages,
                messageIndex: 1,
                apiCount: 341,
                uiCount: messages.length,
            }),
        ).toThrowError("Restore API boundary is outside the current conversation")
    })
})
