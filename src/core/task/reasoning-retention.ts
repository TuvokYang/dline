import type { ClineAssistantRedactedThinkingBlock, ClineStorageMessage } from "@/shared/messages/content"

/**
 * Accumulation policy for encrypted provider reasoning blocks.
 *
 * The Responses API streams one reasoning item as a sequence of events. Its
 * `response.output_item.added` payload is an in-progress snapshot whose `encrypted_content` may
 * still be incomplete, while `response.output_item.done` carries the authoritative payload that a
 * later request must replay. Treating every snapshot as a new block therefore records the same
 * reasoning item dozens of times and inflates one assistant message far beyond any compaction Pass.
 *
 * Snapshots are still worth keeping: when a stream is interrupted before `done`, the newest
 * snapshot is the only encrypted reasoning available for recovery. So snapshots refresh in place
 * per item id — the same partial/final contract used elsewhere in the task runtime — instead of
 * appending.
 */

/** Maximum encrypted reasoning items retained for one provider response. */
export const MAX_ENCRYPTED_REASONING_ITEMS = 64

/** Maximum total encrypted payload bytes retained for one provider response. */
export const MAX_ENCRYPTED_REASONING_BYTES = 256_000

export interface EncryptedReasoningBudget {
    readonly maxItems: number
    readonly maxBytes: number
}

export const DEFAULT_ENCRYPTED_REASONING_BUDGET: EncryptedReasoningBudget = {
    maxItems: MAX_ENCRYPTED_REASONING_ITEMS,
    maxBytes: MAX_ENCRYPTED_REASONING_BYTES,
}

/** Stream phase that produced an encrypted reasoning payload. */
export type EncryptedReasoningPhase = "partial" | "final"

interface EncryptedReasoningEntry {
    block: ClineAssistantRedactedThinkingBlock
    phase: EncryptedReasoningPhase
}

/**
 * Measure the encrypted payload size of one block.
 *
 * @param block The encrypted reasoning block to measure.
 * @returns The payload size in bytes, or 0 when the block carries no data.
 */
export function encryptedReasoningBlockBytes(block: ClineAssistantRedactedThinkingBlock): number {
    return typeof block.data === "string" ? Buffer.byteLength(block.data, "utf8") : 0
}

/**
 * Accumulate encrypted reasoning items by identity, refreshing in place until each item is final.
 *
 * Ordering follows first observation of an item so the recorded sequence matches the provider
 * stream. A `final` payload replaces any earlier snapshot for the same item and is never
 * overwritten by a late snapshot.
 */
export class EncryptedReasoningAccumulator {
    private readonly entries = new Map<string, EncryptedReasoningEntry>()
    private droppedItemCount = 0

    constructor(private readonly budget: EncryptedReasoningBudget = DEFAULT_ENCRYPTED_REASONING_BUDGET) {}

    /**
     * Record one encrypted reasoning payload.
     *
     * @param itemId Stable provider item id used as the refresh key.
     * @param block The encrypted reasoning block carrying the payload.
     * @param phase Whether the payload is an in-progress snapshot or the authoritative final item.
     * @returns Whether the payload was retained.
     */
    record(itemId: string, block: ClineAssistantRedactedThinkingBlock, phase: EncryptedReasoningPhase): boolean {
        const existing = this.entries.get(itemId)
        if (existing) {
            // A final payload is authoritative; a later snapshot must not overwrite it.
            if (existing.phase === "final" && phase !== "final") {
                return false
            }
            existing.block = block
            existing.phase = phase
            return true
        }

        if (!this.hasRoomForNewItem(block)) {
            this.droppedItemCount += 1
            return false
        }
        this.entries.set(itemId, { block, phase })
        return true
    }

    /** Return the retained blocks in provider stream order. */
    blocks(): ClineAssistantRedactedThinkingBlock[] {
        return [...this.entries.values()].map((entry) => entry.block)
    }

    /** Number of distinct reasoning items rejected because the budget was exhausted. */
    droppedItems(): number {
        return this.droppedItemCount
    }

    /** Total retained encrypted payload size in bytes. */
    retainedBytes(): number {
        let total = 0
        for (const entry of this.entries.values()) {
            total += encryptedReasoningBlockBytes(entry.block)
        }
        return total
    }

    private hasRoomForNewItem(block: ClineAssistantRedactedThinkingBlock): boolean {
        const maxItems = Math.max(0, Math.floor(this.budget.maxItems))
        const maxBytes = Math.max(0, Math.floor(this.budget.maxBytes))
        if (this.entries.size >= maxItems) {
            return false
        }
        return this.retainedBytes() + encryptedReasoningBlockBytes(block) <= maxBytes
    }
}

export interface EncryptedReasoningRepairResult {
    readonly messages: ClineStorageMessage[]
    readonly removedBlockCount: number
    readonly repairedMessageCount: number
}

/**
 * Repair histories persisted before encrypted reasoning was accumulated by item id.
 *
 * Those histories recorded one in-progress snapshot per stream event, so a single assistant
 * message can hold thousands of `redacted_thinking` blocks that repeat the same reasoning items.
 * Such a message no longer fits any compaction Pass, which permanently blocks the task.
 *
 * Repair keeps the last block per reasoning item — the newest snapshot is the closest to the
 * provider's authoritative payload — and applies the same budget used while streaming. Messages
 * that are already well formed are returned untouched.
 *
 * @param messages The persisted conversation history.
 * @param budget The retention budget to enforce.
 * @returns The repaired history plus counts describing what was removed.
 */
export function repairPersistedEncryptedReasoning(
    messages: readonly ClineStorageMessage[],
    budget: EncryptedReasoningBudget = DEFAULT_ENCRYPTED_REASONING_BUDGET,
): EncryptedReasoningRepairResult {
    let removedBlockCount = 0
    let repairedMessageCount = 0

    const repaired = messages.map((message) => {
        if (message.role !== "assistant" || !Array.isArray(message.content)) return message

        const content = message.content as readonly unknown[]
        const redactedIndexes: number[] = []
        const accumulator = new EncryptedReasoningAccumulator(budget)
        let anonymousCount = 0

        content.forEach((block, index) => {
            if (!isRedactedThinkingBlock(block)) return
            redactedIndexes.push(index)
            const itemId = block.provider_metadata?.response_id ?? `anonymous:${anonymousCount++}`
            // Persisted blocks carry no phase, and a later block supersedes an earlier one.
            accumulator.record(itemId, block, "partial")
        })
        if (redactedIndexes.length === 0) return message

        const retained = new Set<ClineAssistantRedactedThinkingBlock>(accumulator.blocks())
        if (retained.size === redactedIndexes.length) return message

        const nextContent = content.filter(
            (block, index) => !redactedIndexes.includes(index) || retained.has(block as ClineAssistantRedactedThinkingBlock),
        )
        removedBlockCount += redactedIndexes.length - retained.size
        repairedMessageCount += 1
        return { ...message, content: nextContent } as ClineStorageMessage
    })

    return { messages: repaired, removedBlockCount, repairedMessageCount }
}

function isRedactedThinkingBlock(block: unknown): block is ClineAssistantRedactedThinkingBlock {
    return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "redacted_thinking"
}
