import type { CompactionConversationRange } from "@shared/ExtensionMessage"
import type { TargetWindowFittingState } from "./target-window-fitting"

/** Build the single durable canonical range represented by a completed compaction operation. */
export function createCompactionConversationRange(
    state: TargetWindowFittingState,
    preCompactionApiEndIndex: number,
): CompactionConversationRange {
    if (state.coveredTurnCount <= 0 || state.coveredTurnCount > state.turns.length) {
        throw new Error("Completed compaction must cover at least one valid logical turn")
    }
    if (!Number.isInteger(preCompactionApiEndIndex) || preCompactionApiEndIndex < 0) {
        throw new Error("Completed compaction requires a valid pre-compaction API end index")
    }

    const sourceRanges = state.sourceSnapshot.canonicalRanges
    const coveredRanges = state.turns
        .slice(0, state.coveredTurnCount)
        .flatMap((turn) => sourceRanges.slice(turn.startMessageIndex, turn.endMessageIndex + 1))
        .filter((range): range is readonly [number, number] => range !== undefined)
    if (coveredRanges.length === 0) {
        throw new Error("Completed compaction has no canonical source range")
    }

    const apiStart = Math.min(...coveredRanges.map(([start]) => start))
    const apiEnd = Math.max(...coveredRanges.map(([, end]) => end))
    if (apiStart < 0 || apiEnd < apiStart || apiEnd > preCompactionApiEndIndex) {
        throw new Error("Completed compaction canonical source range is invalid")
    }

    return {
        logicalTurnRange: [0, state.coveredTurnCount - 1],
        apiConversationRange: [apiStart, apiEnd],
        preCompactionApiEndIndex,
    }
}
