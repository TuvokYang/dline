import { describe, expect, it } from "vitest"
import type { ClineAssistantRedactedThinkingBlock, ClineStorageMessage } from "@/shared/messages/content"
import {
    EncryptedReasoningAccumulator,
    encryptedReasoningBlockBytes,
    MAX_ENCRYPTED_REASONING_ITEMS,
    repairPersistedEncryptedReasoning,
} from "../reasoning-retention"

function block(data: string, responseId?: string): ClineAssistantRedactedThinkingBlock {
    return {
        type: "redacted_thinking",
        data,
        ...(responseId ? { provider_metadata: { response_id: responseId } } : {}),
    } as ClineAssistantRedactedThinkingBlock
}

describe("EncryptedReasoningAccumulator", () => {
    it("refreshes one reasoning item in place instead of appending each snapshot", () => {
        const accumulator = new EncryptedReasoningAccumulator()

        accumulator.record("rs_1", block("part"), "partial")
        accumulator.record("rs_1", block("partial-grown"), "partial")
        accumulator.record("rs_1", block("complete-payload"), "final")

        const blocks = accumulator.blocks()
        expect(blocks).toHaveLength(1)
        expect(blocks[0].data).toBe("complete-payload")
    })

    it("keeps the newest snapshot when the stream is interrupted before the final payload", () => {
        const accumulator = new EncryptedReasoningAccumulator()

        accumulator.record("rs_1", block("snapshot-1"), "partial")
        accumulator.record("rs_1", block("snapshot-2"), "partial")

        expect(accumulator.blocks().map((entry) => entry.data)).toEqual(["snapshot-2"])
    })

    it("does not let a late snapshot overwrite the authoritative final payload", () => {
        const accumulator = new EncryptedReasoningAccumulator()

        accumulator.record("rs_1", block("complete-payload"), "final")
        const accepted = accumulator.record("rs_1", block("stale-snapshot"), "partial")

        expect(accepted).toBe(false)
        expect(accumulator.blocks().map((entry) => entry.data)).toEqual(["complete-payload"])
    })

    it("retains distinct reasoning items in provider stream order", () => {
        const accumulator = new EncryptedReasoningAccumulator()

        accumulator.record("rs_1", block("first"), "partial")
        accumulator.record("rs_2", block("second"), "partial")
        accumulator.record("rs_1", block("first-final"), "final")
        accumulator.record("rs_3", block("third"), "final")

        expect(accumulator.blocks().map((entry) => entry.data)).toEqual(["first-final", "second", "third"])
    })

    it("bounds distinct reasoning items and reports the dropped count", () => {
        const accumulator = new EncryptedReasoningAccumulator({ maxItems: 2, maxBytes: 1_000 })

        expect(accumulator.record("rs_1", block("a"), "final")).toBe(true)
        expect(accumulator.record("rs_2", block("b"), "final")).toBe(true)
        expect(accumulator.record("rs_3", block("c"), "final")).toBe(false)

        expect(accumulator.blocks().map((entry) => entry.data)).toEqual(["a", "b"])
        expect(accumulator.droppedItems()).toBe(1)
    })

    it("bounds total encrypted payload bytes", () => {
        const accumulator = new EncryptedReasoningAccumulator({ maxItems: 100, maxBytes: 10 })

        expect(accumulator.record("rs_1", block("12345"), "final")).toBe(true)
        expect(accumulator.record("rs_2", block("67890"), "final")).toBe(true)
        expect(accumulator.record("rs_3", block("x"), "final")).toBe(false)

        expect(accumulator.retainedBytes()).toBe(10)
        expect(accumulator.droppedItems()).toBe(1)
    })

    it("still refreshes an already retained item after the budget is exhausted", () => {
        const accumulator = new EncryptedReasoningAccumulator({ maxItems: 1, maxBytes: 1_000 })

        accumulator.record("rs_1", block("snapshot"), "partial")
        accumulator.record("rs_2", block("rejected"), "partial")
        accumulator.record("rs_1", block("final-payload"), "final")

        expect(accumulator.blocks().map((entry) => entry.data)).toEqual(["final-payload"])
    })

    it("measures encrypted payload bytes and tolerates a missing payload", () => {
        expect(encryptedReasoningBlockBytes(block("abc"))).toBe(3)
        expect(encryptedReasoningBlockBytes({ type: "redacted_thinking" } as ClineAssistantRedactedThinkingBlock)).toBe(0)
    })
})

describe("repairPersistedEncryptedReasoning", () => {
    it("collapses repeated snapshots of one reasoning item into its newest block", () => {
        const history: ClineStorageMessage[] = [
            {
                role: "assistant",
                content: [
                    block("snapshot-1", "rs_1"),
                    block("snapshot-2", "rs_1"),
                    block("authoritative", "rs_1"),
                    { type: "text", text: "\n\n[Response interrupted by user]" },
                ],
            } as ClineStorageMessage,
        ]

        const result = repairPersistedEncryptedReasoning(history)

        expect(result.removedBlockCount).toBe(2)
        expect(result.repairedMessageCount).toBe(1)
        const content = result.messages[0].content as unknown[]
        expect(content).toEqual([block("authoritative", "rs_1"), { type: "text", text: "\n\n[Response interrupted by user]" }])
    })

    it("repairs a message shaped like the production incident", () => {
        // One reasoning item repeated as many in-progress snapshots, as older versions persisted.
        const content = Array.from({ length: 2_100 }, (_, index) => block("E".repeat(32), `rs_${index % 15}`)) as unknown[]
        content.push({ type: "text", text: "\n\n[Response interrupted by user]" })
        const history = [{ role: "assistant", content } as ClineStorageMessage]

        const result = repairPersistedEncryptedReasoning(history)

        const repaired = result.messages[0].content as unknown[]
        const redacted = repaired.filter((entry) => (entry as { type?: string }).type === "redacted_thinking")
        expect(redacted).toHaveLength(15)
        expect(result.removedBlockCount).toBe(2_085)
        // The trailing interruption marker must survive the repair.
        expect(repaired.at(-1)).toEqual({ type: "text", text: "\n\n[Response interrupted by user]" })
    })

    it("enforces the retention budget for histories without reusable item ids", () => {
        const content = Array.from({ length: MAX_ENCRYPTED_REASONING_ITEMS * 3 }, () => block("E".repeat(16))) as unknown[]
        const history = [{ role: "assistant", content } as ClineStorageMessage]

        const result = repairPersistedEncryptedReasoning(history)

        const redacted = (result.messages[0].content as unknown[]).filter(
            (entry) => (entry as { type?: string }).type === "redacted_thinking",
        )
        expect(redacted.length).toBeLessThanOrEqual(MAX_ENCRYPTED_REASONING_ITEMS)
    })

    it("leaves already well-formed histories untouched", () => {
        const history: ClineStorageMessage[] = [
            { role: "user", content: [{ type: "text", text: "task" }] } as ClineStorageMessage,
            {
                role: "assistant",
                content: [block("payload-a", "rs_1"), block("payload-b", "rs_2"), { type: "text", text: "done" }],
            } as ClineStorageMessage,
        ]

        const result = repairPersistedEncryptedReasoning(history)

        expect(result.removedBlockCount).toBe(0)
        expect(result.repairedMessageCount).toBe(0)
        expect(result.messages[0]).toBe(history[0])
        expect(result.messages[1]).toBe(history[1])
    })

    it("ignores user messages and string content", () => {
        const history: ClineStorageMessage[] = [
            { role: "user", content: "plain string" } as unknown as ClineStorageMessage,
            { role: "assistant", content: "plain string" } as unknown as ClineStorageMessage,
        ]

        const result = repairPersistedEncryptedReasoning(history)

        expect(result.removedBlockCount).toBe(0)
        expect(result.messages).toEqual(history)
    })
})
