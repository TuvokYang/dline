import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { finishedRequest, restorePoint, userFeedback } from "../components/messages/activityFoldStoryFixtures"
import { isActivityFold } from "./chatRowKinds"
import { groupChatRows } from "./messageUtils"

/**
 * A turn whose only finished work is its round-start restore point.
 *
 * This is the shape the extension writes when a request ends with a completion
 * and nothing else: the restore point is the round's only row besides the turn
 * end, so the block that carries it is where Restore lives.
 */
const completionOnlyTurn = (base: number): UiMessage[] => [
    userFeedback(base, "Continue with the same idea"),
    restorePoint(base + 1, "tree-a"),
    finishedRequest(base + 2),
    { ts: base + 3, type: "ask", ask: "completion_result", text: "All done." },
]

/**
 * The shape a real task writes: the round-start restore point, the request it
 * protects, and the completion. The request row draws nothing on success, so the
 * restore point and the turn end become adjacent rows in the visible list while
 * the request still separates them in the transcript.
 */
const requestBetweenRestorePointAndTurnEnd = (base: number): UiMessage[] => [
    { ts: base, type: "say", say: "user_feedback", text: "Continue with the same idea" },
    restorePoint(base + 1, "tree-a"),
    finishedRequest(base + 2),
    { ts: base + 3, type: "ask", ask: "completion_result", text: "All done." },
]

const folds = (messages: UiMessage[]) => groupChatRows(messages, undefined, { level: "user_turn" }).filter(isActivityFold)

describe("fold a turn whose only work is a restore point", () => {
    it("keeps that turn foldable so its Restore control has a block to live in", () => {
        const turn = completionOnlyTurn(10)

        const blocks = folds(turn)

        expect(blocks).toHaveLength(1)
        expect(blocks[0].map(({ ts }) => ts)).toContain(11)
    })

    it("folds a turn whose request row drew nothing between its restore point and its end", () => {
        const turn = requestBetweenRestorePointAndTurnEnd(20)

        const blocks = folds(turn)

        expect(blocks).toHaveLength(1)
        expect(blocks[0].map(({ ts }) => ts)).toContain(21)
    })

    it("still draws one block per turn when a second turn follows", () => {
        const first: UiMessage[] = [
            { ts: 1, type: "say", say: "task", text: "Start" },
            restorePoint(2, "tree-a"),
            finishedRequest(3),
            { ts: 4, type: "ask", ask: "completion_result", text: "Done." },
        ]
        const messages = [...first, ...completionOnlyTurn(10)]

        const texts = folds(messages).map((block) => block.map(({ ts }) => ts))

        expect(texts).toHaveLength(2)
        expect(texts[0]).toContain(2)
        expect(texts[1]).toContain(11)
    })
})
