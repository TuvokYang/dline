import type { ClineStorageMessage } from "@shared/messages/content"
import cloneDeep from "clone-deep"
import type { CanonicalMessageRange } from "./compaction-context-projection"
import { hashCompactionValue } from "./compaction-hash"
import { type ContextWindowCandidateEstimator, estimateContextValueBreakdown } from "./context-window-projection"

/** Immutable operation-scoped canonical source shared by every compaction Pass. */
export interface CompactionSourceSnapshot {
    readonly messages: readonly ClineStorageMessage[]
    readonly canonicalRanges: readonly (CanonicalMessageRange | undefined)[]
    /** Prefix sums of conservative serialized-message token contributions. */
    readonly messageTokenPrefixSums: readonly number[]
    readonly sourceHistoryHash: string
}

/** Capture the compaction source exactly once at operation admission. */
export function createCompactionSourceSnapshot(
    messages: readonly ClineStorageMessage[],
    canonicalRanges: readonly (CanonicalMessageRange | undefined)[] = [],
    estimator: ContextWindowCandidateEstimator = {},
): CompactionSourceSnapshot {
    if (canonicalRanges.length > 0 && canonicalRanges.length !== messages.length) {
        throw new Error("Compaction source canonical range mapping must align with source history")
    }
    const detachedMessages = cloneDeep([...messages])
    const detachedRanges = canonicalRanges.length > 0 ? cloneDeep([...canonicalRanges]) : detachedMessages.map(() => undefined)
    return {
        messages: detachedMessages,
        canonicalRanges: detachedRanges,
        messageTokenPrefixSums: buildMessageTokenPrefixSums(detachedMessages, estimator),
        sourceHistoryHash: hashCompactionValue(detachedMessages),
    }
}

/** Estimate an inclusive source-message range in O(1) from operation-scoped prefix sums. */
export function estimateCompactionSourceRangeTokens(
    snapshot: CompactionSourceSnapshot,
    startMessageIndex: number,
    endMessageIndex: number,
): number {
    if (startMessageIndex < 0 || endMessageIndex < startMessageIndex || endMessageIndex >= snapshot.messages.length) {
        throw new Error("Compaction source token range is out of bounds")
    }
    return snapshot.messageTokenPrefixSums[endMessageIndex + 1] - snapshot.messageTokenPrefixSums[startMessageIndex]
}

/** Materialize a detached inclusive source-message span for one Provider request. */
export function materializeCompactionSourceRange(
    snapshot: CompactionSourceSnapshot,
    startMessageIndex: number,
    endMessageIndex: number,
): ClineStorageMessage[] {
    if (endMessageIndex < startMessageIndex) return []
    if (startMessageIndex < 0 || endMessageIndex >= snapshot.messages.length) {
        throw new Error("Compaction source message range is out of bounds")
    }
    return cloneDeep(snapshot.messages.slice(startMessageIndex, endMessageIndex + 1))
}

/** Materialize a detached suffix from the immutable source. */
export function materializeCompactionSourceSuffix(
    snapshot: CompactionSourceSnapshot,
    startMessageIndex: number,
): ClineStorageMessage[] {
    if (startMessageIndex >= snapshot.messages.length) return []
    return materializeCompactionSourceRange(snapshot, startMessageIndex, snapshot.messages.length - 1)
}

function buildMessageTokenPrefixSums(
    messages: readonly ClineStorageMessage[],
    estimator: ContextWindowCandidateEstimator,
): number[] {
    const prefixSums = [0]
    for (const message of messages) {
        const messageTokens = estimateContextValueBreakdown(message, estimator).totalTokens
        prefixSums.push(prefixSums[prefixSums.length - 1] + messageTokens)
    }
    return prefixSums
}
