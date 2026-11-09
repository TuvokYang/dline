import { FetchMessageRequest, TrajectoryTurnSummary } from "@shared/proto/dline/task"
import { ClineMessage } from "@shared/proto/dline/ui"
import { describe, expect, it } from "vitest"
import { trajectoryFrameToProto } from "./trajectory"

const indices = [undefined, 0, 37]

describe("source-index transport", () => {
    it.each(indices)("preserves request index %s through binary and JSON", (anchorIndex) => {
        const request = FetchMessageRequest.create({ anchorIndex, anchorTs: 900 })
        const binary = FetchMessageRequest.decode(FetchMessageRequest.encode(request).finish())
        const json = FetchMessageRequest.fromJSON(FetchMessageRequest.toJSON(request))
        expect(binary.anchorIndex).toBe(anchorIndex)
        expect(json.anchorIndex).toBe(anchorIndex)
        expect(binary.anchorTs).toBe(900)
    })

    it.each(indices)("preserves turn index %s through binary and JSON", (anchorIndex) => {
        const turn = TrajectoryTurnSummary.create({ anchorIndex, anchorTs: 800 })
        const binary = TrajectoryTurnSummary.decode(TrajectoryTurnSummary.encode(turn).finish())
        const json = TrajectoryTurnSummary.fromJSON(TrajectoryTurnSummary.toJSON(turn))
        expect(binary.anchorIndex).toBe(anchorIndex)
        expect(json.anchorIndex).toBe(anchorIndex)
        expect(binary.anchorTs).toBe(800)
    })

    it.each(indices)("preserves message index %s through binary and JSON", (messageIndex) => {
        const message = ClineMessage.create({ messageIndex, ts: 700 })
        const binary = ClineMessage.decode(ClineMessage.encode(message).finish())
        const json = ClineMessage.fromJSON(ClineMessage.toJSON(message))
        expect(binary.messageIndex).toBe(messageIndex)
        expect(json.messageIndex).toBe(messageIndex)
        expect(binary.ts).toBe(700)
    })

    it("carries every source anchor independently of timestamp order", () => {
        const result = trajectoryFrameToProto(
            {
                state: "ready",
                revision: 4,
                baseRevision: 3,
                reset: false,
                turnCount: 2,
                turns: [
                    {
                        seq: 0,
                        attemptSeq: 0,
                        anchorIndex: 0,
                        anchorTs: 900,
                        prompt: "first",
                        rounds: 2,
                        toolUsage: [{ tool: "read_file", count: 3 }],
                        endsAttempt: false,
                        tailTs: 600,
                    },
                    {
                        seq: 1,
                        attemptSeq: 0,
                        anchorIndex: 12,
                        anchorTs: 500,
                        prompt: "second",
                        rounds: 1,
                        toolUsage: [],
                        endsAttempt: true,
                        tailTs: 400,
                    },
                ],
            },
            { taskId: "task", taskInstanceId: "opening" },
        )
        expect(result.turns.map((turn) => [turn.seq, turn.anchorIndex, turn.anchorTs, turn.rounds, turn.toolUsage])).toEqual([
            [0, 0, 900, 2, [{ tool: "read_file", count: 3 }]],
            [1, 12, 500, 1, []],
        ])
        expect(result).toMatchObject({ taskId: "task", taskInstanceId: "opening", revision: 4, baseRevision: 3, turnCount: 2 })
    })
})
