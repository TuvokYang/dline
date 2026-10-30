import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { isActivityFold, isBrowserSession, isExplorationRun } from "../../utils/chatRowKinds"
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
import { DESIGN_FOLDING_MODES, designFoldRows, openDesignRows } from "./foldingTrajectoryDesign"
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

const allOpen = (rows: (UiMessage | UiMessage[])[]) =>
    Object.fromEntries(rows.filter(isActivityFold).map((row) => [row._activityFoldId, true]))

function expectOriginalRows(actual: (UiMessage | UiMessage[])[], expected: (UiMessage | UiMessage[])[]) {
    expect(actual).toHaveLength(expected.length)
    actual.forEach((row, index) => {
        expect(row).toBe(expected[index])
    })
}

describe("Storybook folding design", () => {
    // Catches dropping, reordering, cloning or regrouping Standard rows, including tagged groups.
    for (const level of ["message_segment", "user_turn"] as const) {
        for (const [name, messages] of [
            ["finished", finishedTurnTranscript],
            ["live / failed / checked-out", multiTurnTranscript],
            ["browser", browserTranscript],
        ] as const) {
            it(`${level} fully opens to the original ${name} Standard rows, not nested fold renderers`, () => {
                const standard = groupChatRows([...messages], undefined, { level: "none" })
                const proposed = designFoldRows([...messages], standard, level)
                expect(proposed.some(isActivityFold)).toBe(true)
                expectOriginalRows(openDesignRows(proposed, allOpen(proposed)), standard)
                for (const fold of proposed.filter(isActivityFold)) {
                    expect(fold._children.some(isActivityFold)).toBe(false)
                    fold._children.forEach((child) => {
                        expect(standard.includes(child)).toBe(true)
                    })
                }
            })
        }
    }

    it("message-segment blocks stop at communication and user boundaries without moving those rows", () => {
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
        const folds = proposed.filter(isActivityFold)
        expect(folds.map((fold) => fold.map((message) => message.ts))).toEqual([[3], [5], [9]])
        const partial = openDesignRows(proposed, { [folds[0]._activityFoldId]: true })
        expect(partial.map(rowIdentity)).toEqual(["1", "3", "4", "segment:5", "6", "7", "segment:9", "10"])
        expect(partial[1]).toBe(standard[1])
        expect(partial[2]).toBe(standard[2])
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
            expect(proposed.filter(isActivityFold).map((fold) => fold.map((message) => message.ts))).toEqual(
                hasToolBetweenMessages ? [[4]] : [],
            )
            expectOriginalRows(openDesignRows(proposed, allOpen(proposed)), standard)
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
                expect(proposed.map(rowIdentity)).toEqual([
                    "1",
                    "3",
                    "segment:4",
                    "7",
                    "segment:8",
                    "9",
                    "segment:10",
                    "11",
                    "12",
                    "segment:14",
                    "15",
                ])
                // No message separates requests 2 and 5, so their commands stay in one block.
                expect(proposed.filter(isActivityFold).map((fold) => fold.map((message) => message.ts))).toEqual([
                    [4, 6],
                    [8],
                    [10],
                    [14],
                ])
            } else {
                expect(proposed.map(rowIdentity)).toEqual(["1", "turn:3", "11", "12", "turn:14", "15"])
                // The original whole-turn policy does not split at plain text, Reply or Phase report.
                expect(proposed.filter(isActivityFold).map((fold) => fold.map((message) => message.ts))).toEqual([
                    [3, 4, 6, 7, 8, 9, 10],
                    [14],
                ])
            }
            expectOriginalRows(openDesignRows(proposed, allOpen(proposed)), standard)
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
        it(`the actual ${mode} story fixture opens back to the same Standard rows`, () => {
            const messages = createFoldingTranscript(2)
            const standard = groupChatRows(messages, undefined, { level: "none" })
            const proposed = designFoldRows(messages, standard, mode)
            expectOriginalRows(openDesignRows(proposed, allOpen(proposed)), standard)
        })
    }

    it("retains the original exploration and browser group objects, including their internal metadata", () => {
        for (const [messages, guard] of [
            [finishedTurnTranscript, isExplorationRun],
            [browserTranscript, isBrowserSession],
        ] as const) {
            const standard = groupChatRows(messages, undefined, { level: "none" })
            const groups = standard.filter(guard)
            expect(groups.length).toBeGreaterThan(0)
            const proposed = designFoldRows(messages, standard, "message_segment")
            const open = openDesignRows(proposed, allOpen(proposed))
            groups.forEach((group) => {
                expect(open.find((row) => row === group)).toBe(group)
            })
        }
    })
})
