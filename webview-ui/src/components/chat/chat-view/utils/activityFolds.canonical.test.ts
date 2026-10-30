import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
    assistantText,
    completion,
    finishedCommand,
    finishedRequest,
    userFeedback,
    userTask,
    workingRespond,
} from "../components/messages/activityFoldStoryFixtures"
import { foldActivity, projectFoldExpansion } from "./activityFolds"
import { isActivityFold } from "./chatRowKinds"
import { buildFoldContext } from "./foldContext"
import { groupChatRows, indexRequestRounds } from "./messageUtils"
import { rowIdentity } from "./rowCoordinate"

const transcript: UiMessage[] = [
    userTask(1, "Check the sources"),
    finishedRequest(2),
    assistantText(3, "Starting the checks."),
    finishedCommand(4, "npm run lint"),
    finishedRequest(5),
    finishedCommand(6, "npm run check-types"),
    workingRespond(7, "The first checks passed."),
    finishedCommand(8, "npm run test:smoke"),
    { ts: 9, type: "say", say: "tool", text: JSON.stringify({ tool: "statusUpdate", content: "Checks finished." }) },
    finishedCommand(10, "git diff --check"),
    completion(11, "Done."),
    userFeedback(12, "Check the next module"),
    finishedRequest(13),
    finishedCommand(14, "npm run lint"),
    completion(15, "Next module checked."),
]

for (const level of ["message_segment", "user_turn"] as const) {
    describe(`canonical ${level}`, () => {
        it("uses message boundaries only in the second mode, not model-request boundaries", () => {
            const rows = groupChatRows(transcript, undefined, { level })
            expect(rows.map(rowIdentity)).toEqual(
                level === "message_segment"
                    ? ["1", "3", "segment:4", "7", "segment:8", "9", "segment:10", "11", "12", "segment:14", "15"]
                    : ["1", "turn:3", "11", "12", "turn:14", "15"],
            )
            expect(rows.filter(isActivityFold).map((fold) => fold.map((message) => message.ts))).toEqual(
                level === "message_segment" ? [[4, 6], [8], [10], [14]] : [[3, 4, 6, 7, 8, 9, 10], [14]],
            )
        })

        it("opens into the exact Standard row objects and positions without fold wrappers", () => {
            const standard = groupChatRows(transcript, undefined, { level: "none" })
            const context = buildFoldContext(transcript, indexRequestRounds(transcript))
            const folded = foldActivity(standard, { level }, context)
            const expanded = Object.fromEntries(folded.filter(isActivityFold).map((fold) => [fold._activityFoldId, true]))
            const projected = projectFoldExpansion(folded, expanded)
            expect(projected).toHaveLength(standard.length)
            projected.forEach((row, index) => {
                expect(row).toBe(standard[index])
                expect(isActivityFold(row)).toBe(false)
            })
        })

        it("leaves running and failed commands outside every fold", () => {
            const messages = transcript.map((message) =>
                message.ts === 6
                    ? { ...message, commandStatus: "running" as const }
                    : message.ts === 10
                      ? { ...message, commandStatus: "failed" as const, exitCode: 1 }
                      : message,
            )
            const rows = groupChatRows(messages, undefined, { level })
            expect(rows.filter((row) => !Array.isArray(row)).map((row) => row.ts)).toEqual(expect.arrayContaining([6, 10]))
            const foldedTimestamps = rows.filter(isActivityFold).flatMap((fold) => fold.map((message) => message.ts))
            expect(foldedTimestamps).not.toContain(6)
            expect(foldedTimestamps).not.toContain(10)
        })
    })
}
