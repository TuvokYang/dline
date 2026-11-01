import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { isActivityFold, isExplorationRun } from "../../utils/chatRowKinds"
import { groupChatRows } from "../../utils/messageUtils"
import { rowIdentity } from "../../utils/rowCoordinate"
import {
    assistantText,
    completion,
    finishedCommand,
    finishedRequest,
    finishedTurnTranscript,
    multiTurnTranscript,
    userFeedback,
    userTask,
    workingRespond,
} from "../messages/activityFoldStoryFixtures"
import { DESIGN_FOLDING_MODES, designFoldRows } from "./foldingTrajectoryDesign"
import { createFoldingTranscript } from "./foldingTrajectoryStoryFixtures"

const browser = (ts: number, action: string): UiMessage => ({
    ts,
    type: "say",
    say: "browser_action",
    text: JSON.stringify({ action, url: "https://example.test" }),
})

// Communication inside a Standard browser card must not be extracted into another row.
const browserTranscript = [
    userTask(1, "Inspect the page"),
    finishedRequest(2),
    browser(3, "launch"),
    assistantText(4, "The page has loaded."),
    browser(5, "close"),
    finishedRequest(6),
    completion(7, "Inspection complete."),
]

/** Every message the rows draw, in order, so nothing is lost or reordered by folding. */
function drawnTimestamps(rows: readonly (UiMessage | UiMessage[])[]): number[] {
    return rows.flatMap((row) => (Array.isArray(row) ? row : [row]).map((message) => message.ts))
}

const foldMembers = (rows: readonly (UiMessage | UiMessage[])[]) =>
    rows.filter(isActivityFold).map((fold) => fold.map((message) => message.ts))

describe("Storybook folding design", () => {
    // Catches dropping, reordering or duplicating rows.
    for (const level of ["message_segment", "user_turn"] as const) {
        for (const [name, messages] of [
            ["finished", finishedTurnTranscript],
            ["live / failed / checked-out", multiTurnTranscript],
            ["browser", browserTranscript],
        ] as const) {
            it(`${level} keeps every ${name} row exactly once, in order`, () => {
                const standard = groupChatRows([...messages], undefined, { level: "none" })
                const folded = designFoldRows([...messages], standard, level)
                const drawn = drawnTimestamps(folded)
                expect(drawn).toEqual(drawnTimestamps(standard))
                expect(new Set(drawn).size).toBe(drawn.length)
            })
        }
    }

    // The defect the review is about: a row that reports several request rounds.
    for (const level of ["message_segment", "user_turn"] as const) {
        it(`${level} never draws an exploration run that spans request rounds`, () => {
            const messages = createFoldingTranscript(2)
            const standard = groupChatRows(messages, undefined, { level: "none" })
            const folded = designFoldRows(messages, standard, level)
            expect(folded.some(isExplorationRun)).toBe(false)
            expect(folded.some((row) => isActivityFold(row) && row._roundCount > (level === "user_turn" ? 99 : 1))).toBe(false)
        })
    }

    it("message level keeps every block inside one request round", () => {
        const messages = createFoldingTranscript(2)
        const standard = groupChatRows(messages, undefined, { level: "none" })
        const folds = designFoldRows(messages, standard, "message_segment").filter(isActivityFold)
        expect(folds.length).toBeGreaterThan(0)
        for (const fold of folds) expect(fold._roundCount).toBe(1)
    })

    it("turn level merges the rounds of one turn into a single block", () => {
        const messages = finishedTurnTranscript
        const standard = groupChatRows(messages, undefined, { level: "none" })
        const folds = designFoldRows(messages, standard, "user_turn").filter(isActivityFold)
        expect(folds).toHaveLength(1)
        expect(folds[0]._roundCount).toBeGreaterThan(1)
    })

    it("message-segment blocks stop at communication and user boundaries", () => {
        const messages = [
            userTask(1, "Run the checks"),
            finishedRequest(2),
            finishedCommand(3, "npm run lint"),
            workingRespond(4, "The lint check passed."),
            finishedCommand(5, "npm run check-types"),
            completion(6, "Checks complete."),
            userFeedback(7, "Check the next module"),
            finishedRequest(8),
            finishedCommand(9, "npm run lint"),
            completion(10, "Next module checked."),
        ]
        const standard = groupChatRows(messages, undefined, { level: "none" })
        const proposed = designFoldRows(messages, standard, "message_segment")
        expect(proposed.map(rowIdentity)).toEqual(["1", "segment:3", "4", "segment:5", "6", "7", "segment:9", "10"])
        // Every fold holds activity only; the Reply row stays its own row.
        expect(foldMembers(proposed)).toEqual([[3], [5], [9]])
    })

    for (const hasToolBetweenMessages of [false, true]) {
        it(`keeps Reply/report order ${hasToolBetweenMessages ? "with" : "without"} intervening tool activity`, () => {
            const report: UiMessage = {
                ts: 5,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "statusUpdate", content: "Checks finished." }),
            }
            const messages = [
                userTask(1, "Check the module"),
                finishedRequest(2),
                workingRespond(3, "Starting the checks."),
                ...(hasToolBetweenMessages ? [finishedCommand(4, "npm run lint")] : []),
                report,
                completion(6, "Done."),
            ]
            const standard = groupChatRows(messages, undefined, { level: "none" })
            const proposed = designFoldRows(messages, standard, "message_segment")
            expect(proposed.map(rowIdentity)).toEqual(
                hasToolBetweenMessages ? ["1", "3", "segment:4", "5", "6"] : ["1", "3", "5", "6"],
            )
            expect(foldMembers(proposed)).toEqual(hasToolBetweenMessages ? [[4]] : [])
            expect(drawnTimestamps(proposed)).toEqual(drawnTimestamps(standard))
        })
    }

    for (const mode of ["message_segment", "user_turn"] as const) {
        it(`${mode} uses the correct boundary across model requests and assistant messages`, () => {
            const messages: UiMessage[] = [
                userTask(1, "Check the module"),
                finishedRequest(2),
                assistantText(3, "First inspect the module."),
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
            const standard = groupChatRows(messages, undefined, { level: "none" })
            const proposed = designFoldRows(messages, standard, mode)
            if (mode === "message_segment") {
                // Each request round is its own block: 4 and 6 no longer share one.
                expect(proposed.map(rowIdentity)).toEqual([
                    "1",
                    "3",
                    "segment:4",
                    "segment:6",
                    "7",
                    "segment:8",
                    "9",
                    "segment:10",
                    "11",
                    "12",
                    "segment:14",
                    "15",
                ])
                expect(foldMembers(proposed)).toEqual([[4], [6], [8], [10], [14]])
            } else {
                expect(proposed.map(rowIdentity)).toEqual(["1", "turn:3", "11", "12", "turn:14", "15"])
                // The turn level keeps the assistant message inside the turn's block.
                expect(foldMembers(proposed)).toEqual([[3, 4, 6, 7, 8, 9, 10], [14]])
            }
            expect(drawnTimestamps(proposed)).toEqual(drawnTimestamps(standard))
        })
    }

    it("the displayed fixture puts completed execution and a later request between Reply and Phase report", () => {
        const messages = createFoldingTranscript(1)
        const flow = messages
            .filter((message) => message.ts >= 1035)
            .map((message) => {
                if (message.say === "api_req_started") return "request"
                if (message.say === "checkpoint_created") return "checkpoint"
                if (message.ask === "command") return { command: message.commandStatus }
                if (message.ask === "completion_result") return "completion"
                return JSON.parse(message.text ?? "{}").tool
            })
        expect(flow).toEqual([
            "request",
            "actModeRespond",
            "checkpoint",
            "request",
            { command: "completed" },
            "request",
            "statusUpdate",
            "checkpoint",
            "request",
            { command: "completed" },
            "request",
            "completion",
        ])
        const standard = groupChatRows(messages, undefined, { level: "none" })
        const rows = designFoldRows(messages, standard, "message_segment")
        const replyIndex = rows.findIndex((row) => !Array.isArray(row) && row.ts === 1036)
        expect(rows.slice(replyIndex).map(rowIdentity)).toEqual(["1036", "segment:1040", "1044", "segment:1045", "1051"])
    })

    for (const mode of DESIGN_FOLDING_MODES) {
        it(`the actual ${mode} story fixture draws every Standard message once`, () => {
            const messages = createFoldingTranscript(2)
            const standard = groupChatRows(messages, undefined, { level: "none" })
            const proposed = designFoldRows(messages, standard, mode)
            expect(drawnTimestamps(proposed)).toEqual(drawnTimestamps(standard))
        })
    }

    it("never turns a browser row into an exploration run", () => {
        const standard = groupChatRows(browserTranscript, undefined, { level: "none" })
        const proposed = designFoldRows(browserTranscript, standard, "message_segment")
        // Only read-only exploration runs are split by round; a browser card is left alone.
        expect(proposed.some(isExplorationRun)).toBe(false)
        expect(drawnTimestamps(proposed)).toEqual(drawnTimestamps(standard))
    })
})
