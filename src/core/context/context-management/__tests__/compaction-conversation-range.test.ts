import { describe, expect, it } from "vitest"
import { createCompactionConversationRange } from "../compaction-conversation-range"
import { createCompactionSourceSnapshot } from "../compaction-source-snapshot"
import type { TargetWindowFittingState } from "../target-window-fitting"

describe("createCompactionConversationRange", () => {
    it("aggregates canonical messages and superseded card ranges across covered turns", () => {
        const sourceSnapshot = createCompactionSourceSnapshot(
            [
                { role: "user", content: "old summary" },
                { role: "user", content: "new question" },
                { role: "assistant", content: "new answer" },
            ],
            [
                [2, 5],
                [6, 6],
                [7, 7],
            ],
        )
        const state = {
            operationId: "operation-1",
            passIndex: 2,
            passStartTurnIndex: 2,
            passEndTurnIndex: 1,
            coveredTurnCount: 2,
            summaryBaselineHash: "summary",
            sourceHistoryHash: sourceSnapshot.sourceHistoryHash,
            sourceSnapshot,
            turns: [
                { id: "turn-0", startMessageIndex: 0, endMessageIndex: 0, functionIds: [] },
                { id: "turn-1", startMessageIndex: 1, endMessageIndex: 2, functionIds: [] },
            ],
            protectedStartMessageIndex: 3,
            cumulativeSummary: "cumulative summary",
            passPlanned: false,
        } satisfies TargetWindowFittingState

        expect(createCompactionConversationRange(state, 7)).toEqual({
            logicalTurnRange: [0, 1],
            apiConversationRange: [2, 7],
            preCompactionApiEndIndex: 7,
        })
    })
})
