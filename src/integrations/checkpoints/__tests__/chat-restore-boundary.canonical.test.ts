import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { resolveCanonicalChatRestoreBoundary, resolveChatRestoreBoundary } from "../chat-restore-boundary"

const task: UiMessage = { ts: 10, type: "say", say: "task", text: "task" }

function summary(seq: number): UiMessage {
    return {
        ts: 20,
        type: "say",
        say: "tool",
        conversationHistoryIndex: 50,
        text: JSON.stringify({
            tool: "summarizeTask",
            compactionStatus: "completed",
            compactionJournalBoundary: { seq },
        }),
    }
}

describe("canonical Chat Restore presentation boundary", () => {
    it("validates the durable UI sequence without comparing historical indexes with current conversation size", () => {
        const messages: UiMessage[] = [
            task,
            { ts: 20, type: "say", say: "checkpoint_created", conversationHistoryIndex: 50, conversationJournalSeq: 30 },
        ]
        const input = { messages, messageIndex: 1, uiCount: 2 }
        expect(resolveCanonicalChatRestoreBoundary(input)).toEqual({
            uiKeepCount: 2,
            contextAnchorTs: 20,
            conversationHistoryDeletedRange: undefined,
        })
        // A legacy API-row restore still needs an in-range message index.
        expect(() => resolveChatRestoreBoundary({ ...input, apiCount: 3 })).toThrow(
            "Restore API boundary is outside the current conversation",
        )
    })

    it("removes a summary card at its journal target while keeping the preceding UI row", () => {
        const messages = [task, summary(6)]
        expect(resolveCanonicalChatRestoreBoundary({ messages, messageIndex: 1, uiCount: 2 })).toEqual({
            uiKeepCount: 1,
            contextAnchorTs: 10,
            conversationHistoryDeletedRange: undefined,
            journalTarget: { seq: 6 },
        })
    })

    it("refuses stale UI counts and missing rows before reaching the canonical transaction", () => {
        expect(() => resolveCanonicalChatRestoreBoundary({ messages: [task], messageIndex: 0, uiCount: 2 })).toThrow(
            "Restore UI history is stale",
        )
        expect(() => resolveCanonicalChatRestoreBoundary({ messages: [task], messageIndex: 1, uiCount: 1 })).toThrow(
            "Restore message index 1 is unavailable",
        )
    })

    it("refuses a malformed summary target or a summary without a preceding anchor", () => {
        expect(() => resolveCanonicalChatRestoreBoundary({ messages: [task, summary(0)], messageIndex: 1, uiCount: 2 })).toThrow(
            "Compaction Restore boundary is inconsistent",
        )
        expect(() => resolveCanonicalChatRestoreBoundary({ messages: [summary(6)], messageIndex: 0, uiCount: 1 })).toThrow(
            "Compaction Restore boundary is inconsistent",
        )
    })
})
