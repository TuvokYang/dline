import type { AggressiveRenderingLevel } from "@shared/AggressiveRendering"
import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
    finishedRequest,
    readFile,
    restorePoint,
    streamingRequest,
    userTask,
} from "../components/messages/activityFoldStoryFixtures"
import { isActivityFold, isExplorationRun } from "./chatRowKinds"
import { groupChatRows } from "./messageUtils"

const prefix: UiMessage[] = [
    userTask(1, "Read sources"),
    restorePoint(10, "same"),
    finishedRequest(11),
    readFile(12, "a.ts"),
    restorePoint(20, "same"),
    finishedRequest(21),
    readFile(22, "b.ts"),
]
const tail = (partial: boolean): UiMessage[] => [
    restorePoint(30, "same"),
    streamingRequest(31),
    { ...readFile(32, "c.ts"), partial },
]

// A whole-run splitter would fail these member/identity assertions.
for (const level of ["message_segment", "user_turn"] satisfies AggressiveRenderingLevel[]) {
    describe(`${level} completed exploration prefix`, () => {
        it("keeps the completed multi-round prefix closed while a later read streams", () => {
            const before = groupChatRows([...prefix, ...tail(true).slice(0, 2)], undefined, { level }).find(isActivityFold)
            const rows = groupChatRows([...prefix, ...tail(true)], undefined, { level })
            const folds = rows.filter(isActivityFold)
            expect(folds).toHaveLength(1)
            expect(folds[0]._activityFoldId).toBe(before?._activityFoldId)
            expect(folds[0]._roundCount).toBe(2)
            expect(folds[0].map((message) => message.ts)).toEqual([10, 12, 20, 22])
            expect(folds[0]._children.filter(isExplorationRun)).toHaveLength(1)
            const visible = rows.filter((row) => !isActivityFold(row)).flatMap((row) => (Array.isArray(row) ? row : [row]))
            expect(visible.map((message) => message.ts)).toEqual([1, 30, 32])
            expect(visible.find((message) => message.ts === 32)?.partial).toBe(true)
        })

        it("does not treat a final read without a completion boundary as an ended round", () => {
            const rows = groupChatRows([...prefix, ...tail(false)], undefined, { level })
            expect(rows.filter(isActivityFold).flatMap((fold) => fold.map((message) => message.ts))).toEqual([10, 12, 20, 22])
        })

        it("protects checked-out checkpoints and the active ask in the completed prefix", () => {
            const messages = [...prefix, ...tail(true)].map((message) =>
                message.ts === 20 ? { ...message, isCheckpointCheckedOut: true } : message,
            )
            const rows = groupChatRows(messages, undefined, { level, activeAskTs: 12 })
            const folded = rows.filter(isActivityFold).flatMap((fold) => fold.map((message) => message.ts))
            expect(folded).not.toContain(12)
            expect(folded).not.toContain(20)
            expect(folded).not.toContain(32)
        })
    })
}

it("leaves Standard exploration grouping unchanged", () => {
    const rows = groupChatRows([...prefix, ...tail(true)], undefined, { level: "none" })
    const runs = rows.filter(isExplorationRun)
    expect(runs).toHaveLength(1)
    expect(runs[0]._rounds).toHaveLength(3)
    expect(runs[0].map((message) => message.ts)).toEqual([10, 12, 20, 22, 30, 32])
})
