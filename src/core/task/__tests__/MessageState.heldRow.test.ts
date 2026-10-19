import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import type { ConversationHistoryReader } from "../conversation/ConversationHistoryReader"
import { MessageStateHandler } from "../message-state"

/**
 * A round's checkpoint row is shown before its workspace commit settles, and the
 * provider journals and streams the round meanwhile. The held row must keep the
 * conversation place of the round boundary and must not reach disk unsettled.
 */
function createHandler() {
    const durable: UiMessage[] = []
    const journal = { position: 4, size: 3 }
    const conversation: ConversationHistoryReader = {
        read: async () => [],
        count: async () => journal.size,
        size: () => journal.size,
        position: () => journal.position,
    }
    const uiMessage = {
        getAll: () => durable,
        get count() {
            return durable.length
        },
        findIndexByTs: (ts: number) => durable.findIndex((row) => row.ts === ts),
        commitPendingAndAppendDurable: async (message: UiMessage) => {
            durable.push(message)
            return message
        },
        updateMessage: async (index: number, updates: Partial<UiMessage>) => {
            durable[index] = { ...durable[index], ...updates }
            return durable[index]
        },
        // Like the buffered store: a new timestamp is staged at its ascending position.
        upsertMessage: async (message: UiMessage) => {
            const following = durable.findIndex((row) => row.ts > message.ts)
            const index = following === -1 ? durable.length : following
            durable.splice(index, 0, message)
            return { index, message, applied: true }
        },
        flush: async () => {},
    }
    const handler = new MessageStateHandler({
        taskId: "task-held-row",
        ulid: "ulid-held-row",
        updateTaskHistory: async () => [],
        uiMessage: uiMessage as never,
        conversation,
    })
    return { handler, durable, journal }
}

const heldCheckpoint: UiMessage = {
    ts: 50,
    type: "say",
    say: "checkpoint_created",
    checkpointSource: { kind: "round_start", turnId: "turn-1" },
}

describe("held rows", () => {
    it("stores a held row at the conversation place and position it was shown at, ahead of rows written meanwhile", async () => {
        const { handler, durable, journal } = createHandler()

        const held = handler.holdClineMessage(heldCheckpoint)
        expect(held).toMatchObject({ partial: true, conversationJournalSeq: 4, conversationHistoryIndex: 2 })
        expect(durable).toEqual([])

        // The round's reply is journaled and stored while the commit runs.
        journal.position = 7
        journal.size = 5
        handler.upsertTransientClineMessage({ ts: 60, type: "say", say: "text", text: "Working on it", partial: true })
        await handler.commitTransientClineMessage({ ts: 60, type: "say", say: "text", text: "Working on it" })

        const committed = await handler.beginDurableClineMessage({
            ...held,
            lastCheckpointHash: ["round-hash"],
            partial: false,
        }).persistence

        expect(committed).toMatchObject({
            ts: 50,
            partial: false,
            conversationJournalSeq: 4,
            conversationHistoryIndex: 2,
            lastCheckpointHash: ["round-hash"],
        })
        // Restore truncates the stored sequence by position, so it must match the chat.
        expect(durable.map((row) => row.ts)).toEqual([50, 60])
        expect(handler.clineMessages.map((row) => row.ts)).toEqual([50, 60])
    })

    it("drops a withdrawn held row without writing it", () => {
        const { handler, durable } = createHandler()
        handler.holdClineMessage(heldCheckpoint)

        expect(handler.removeTransientClineMessage(50)).toBe(true)

        expect(handler.clineMessages).toEqual([])
        expect(durable).toEqual([])
    })
})
