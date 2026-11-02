import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
    completion,
    editFile,
    failedCommand,
    failedEdit,
    finishedCommand,
    finishedRequest,
    subagentBatch,
    userTask,
} from "../components/messages/activityFoldStoryFixtures"
import { describeActivityFold, describeActivityFoldParts, summarizeActivityFold } from "./activityFoldSummary"
import { foldActivity } from "./activityFolds"
import { isActivityFold } from "./chatRowKinds"
import { buildFoldContext } from "./foldContext"
import { groupChatRows, indexRequestRounds } from "./messageUtils"

/** Build the fold list for a transcript at the user-turn level. */
function folds(transcript: UiMessage[]) {
    const rows = groupChatRows(transcript, undefined, { level: "user_turn" })
    const context = buildFoldContext(transcript, indexRequestRounds(transcript))
    return foldActivity(rows, { level: "user_turn" }, context).filter(isActivityFold)
}

describe("a failed work item stays inside its block", () => {
    it("folds a failed command into the block instead of cutting it", () => {
        const transcript = [
            userTask(1, "Run the checks"),
            finishedRequest(2),
            finishedCommand(3, "npm run lint"),
            failedCommand(4, "npm run test"),
            finishedCommand(5, "git diff --check"),
            completion(6, "Checks finished."),
        ]

        const blocks = folds(transcript)
        expect(blocks).toHaveLength(1)
        // All three commands are members; before this change the failed one split
        // the block in two and stayed visible on its own.
        expect(blocks[0].map((message) => message.ts)).toEqual([3, 4, 5])
    })

    it("counts a failed command as one command error and not as a command", () => {
        const transcript = [
            userTask(1, "Run the checks"),
            finishedRequest(2),
            finishedCommand(3, "npm run lint"),
            failedCommand(4, "npm run test", 2),
            completion(5, "Checks finished."),
        ]

        const block = folds(transcript)[0]
        const summary = summarizeActivityFold(block, new Map())
        expect(summary.failures.get("command")).toBe(1)
        expect(summary.work.get("command")).toBe(1)
        expect(describeActivityFold(summary)).toContain("1 command error")
    })

    it("counts a failed edit as an edit error without counting it as a file edit", () => {
        const transcript = [
            userTask(1, "Fix the parser"),
            finishedRequest(2),
            failedEdit(3, "src/parser.ts"),
            completion(4, "Fixed."),
        ]

        const block = folds(transcript)[0]
        const summary = summarizeActivityFold(block, new Map())
        expect(summary.failures.get("edit")).toBe(1)
        // A failed edit is one error, not also a completed write.
        expect(summary.work.get("write")).toBeUndefined()
        expect(describeActivityFold(summary)).toContain("1 edit error")
    })

    it("states each category separately in the header", () => {
        const transcript = [
            userTask(1, "Do several things"),
            finishedRequest(2),
            failedEdit(3, "src/a.ts"),
            failedEdit(4, "src/b.ts"),
            failedCommand(5, "npm run build"),
            completion(6, "Attempted."),
        ]

        const summary = summarizeActivityFold(folds(transcript)[0], new Map())
        const text = describeActivityFold(summary)
        expect(text).toContain("2 edit errors")
        expect(text).toContain("1 command error")
        expect(text).not.toContain("subagents error")
    })
})

describe("the block keeps a failure it cannot account for out of it", () => {
    it("leaves a running subagent row visible and uncounted", () => {
        const transcript = [
            userTask(1, "Check the modules"),
            finishedRequest(2),
            finishedCommand(3, "npm run lint"),
            subagentBatch(4, "running"),
            completion(5, "Checked."),
        ]

        const blocks = folds(transcript)
        // The live row splits the block, so the finished command before it is its
        // own block and the subagent is not folded anywhere.
        const members = blocks.flatMap((block) => block.map((message) => message.ts))
        expect(members).not.toContain(4)
        for (const block of blocks) expect(summarizeActivityFold(block, new Map()).failures.get("subagent")).toBeUndefined()
    })

    it("folds a failed subagent batch and counts the agents it lost", () => {
        const transcript = [
            userTask(1, "Check the modules"),
            finishedRequest(2),
            finishedCommand(3, "npm run lint"),
            subagentBatch(4, "failed", 2),
            completion(5, "Checked."),
        ]

        const block = folds(transcript)[0]
        // The batch is finished work, so it joins the block rather than splitting it.
        expect(block.map((message) => message.ts)).toEqual([3, 4])
        const summary = summarizeActivityFold(block, new Map())
        expect(summary.failures.get("subagent")).toBe(2)
        expect(describeActivityFold(summary)).toContain("2 subagent errors")
    })

    it("does not count a cancelled subagent batch as an error", () => {
        const transcript = [
            userTask(1, "Check the modules"),
            finishedRequest(2),
            finishedCommand(3, "npm run lint"),
            subagentBatch(4, "cancelled"),
            completion(5, "Checked."),
        ]

        const summary = summarizeActivityFold(folds(transcript)[0], new Map())
        expect(summary.failures.size).toBe(0)
        expect(describeActivityFold(summary)).not.toContain("error")
    })

    it("marks the failure counts as errors and leaves the other counts plain", () => {
        const transcript = [
            userTask(1, "Do several things"),
            finishedRequest(2),
            editFile(3, "src/a.ts"),
            failedCommand(4, "npm run build"),
            completion(5, "Attempted."),
        ]

        const parts = describeActivityFoldParts(summarizeActivityFold(folds(transcript)[0], new Map()))
        // The renderer paints `isFailure` parts in the error tone, so this is what
        // makes an error count read as an error rather than as another tally.
        expect(parts.filter((part) => part.isFailure).map((part) => part.text)).toEqual(["1 command error"])
        expect(parts.filter((part) => !part.isFailure).map((part) => part.text)).toContain("1 write")
    })

    it("does not count a settled edit as an error", () => {
        const transcript = [
            userTask(1, "Fix the parser"),
            finishedRequest(2),
            {
                ts: 3,
                type: "say",
                say: "tool",
                text: JSON.stringify({ tool: "editedExistingFile", path: "src/parser.ts", diff: "-a\n+b" }),
            } as UiMessage,
            completion(4, "Fixed."),
        ]

        const summary = summarizeActivityFold(folds(transcript)[0], new Map())
        expect(summary.failures.size).toBe(0)
        expect(summary.work.get("write")).toBe(1)
        expect(describeActivityFold(summary)).not.toContain("error")
    })
})
