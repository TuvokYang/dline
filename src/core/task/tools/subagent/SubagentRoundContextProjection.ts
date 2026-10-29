import type { ClineStorageMessage, ClineTextContentBlock } from "@shared/messages"

/** One provider-visible suffix frozen for a logical subagent request round. */
export interface FrozenSubagentRoundContext {
    readonly roundId: number
    readonly messageIndex: number
    readonly contentOffset: number
    readonly text: string
}

/**
 * Projects request-only round context onto the canonical subagent conversation.
 *
 * The canonical turns stay free of runtime usage guidance, while every suffix a
 * completed logical round actually sent remains part of all later provider
 * projections. A pending suffix is immutable so transport retries replay the
 * same request instead of re-reading a moving budget.
 */
export class SubagentRoundContextProjection {
    private nextRoundId = 1
    private readonly committed: FrozenSubagentRoundContext[] = []

    freeze(messages: readonly ClineStorageMessage[], text: string | undefined): FrozenSubagentRoundContext | undefined {
        if (!text) return undefined
        for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
            const message = messages[messageIndex]
            if (message.role !== "user" || !Array.isArray(message.content)) continue
            return {
                roundId: this.nextRoundId++,
                messageIndex,
                contentOffset: message.content.length,
                text,
            }
        }
        return undefined
    }

    commit(round: FrozenSubagentRoundContext | undefined): void {
        if (!round || this.committed.some((candidate) => candidate.roundId === round.roundId)) return
        this.committed.push(round)
    }

    project(
        messages: readonly ClineStorageMessage[],
        deletedRange: [number, number] | undefined,
        pending?: FrozenSubagentRoundContext,
    ): ClineStorageMessage[] {
        const rounds = pending ? [...this.committed, pending] : this.committed
        if (rounds.length === 0) return [...messages]

        const byMessage = new Map<number, FrozenSubagentRoundContext[]>()
        for (const round of rounds) {
            const projectedIndex = projectMessageIndex(round.messageIndex, deletedRange)
            if (projectedIndex === undefined || projectedIndex >= messages.length) continue
            const group = byMessage.get(projectedIndex) ?? []
            group.push(round)
            byMessage.set(projectedIndex, group)
        }
        if (byMessage.size === 0) return [...messages]

        const projected = [...messages]
        for (const [messageIndex, messageRounds] of byMessage) {
            const message = projected[messageIndex]
            if (message.role !== "user" || !Array.isArray(message.content)) continue
            const source = message.content
            const content = [] as typeof source
            let cursor = 0
            for (const round of [...messageRounds].sort(compareRoundContext)) {
                const offset = Math.max(cursor, Math.min(source.length, round.contentOffset))
                content.push(...source.slice(cursor, offset))
                content.push({ type: "text", text: round.text } as ClineTextContentBlock)
                cursor = offset
            }
            content.push(...source.slice(cursor))
            projected[messageIndex] = { ...message, content }
        }
        return projected
    }
}

function compareRoundContext(left: FrozenSubagentRoundContext, right: FrozenSubagentRoundContext): number {
    return left.contentOffset - right.contentOffset || left.roundId - right.roundId
}

/** Map a canonical message index through ContextManager's first-pair-plus-suffix projection. */
function projectMessageIndex(index: number, deletedRange: [number, number] | undefined): number | undefined {
    if (!deletedRange || index < 2) return index
    const [, end] = deletedRange
    if (index <= end) return undefined
    return index - (end - 1)
}
