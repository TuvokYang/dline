import { indexPreEditCheckpointAttachments } from "@shared/chat/drawnMessages"
import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
    completion,
    createFile,
    editFile,
    finishedRequest,
    finishedTurnTranscript,
    restorePoint,
    userTask,
    workingRespond,
} from "../components/messages/activityFoldStoryFixtures"
import { describeActivityFold, describeToolCalls, summarizeActivityFold } from "./activityFoldSummary"
import { type ActivityFold, isActivityFold } from "./chatRowKinds"
import { groupChatRows } from "./messageUtils"

function turnFold(messages: UiMessage[]): ActivityFold {
    const fold = groupChatRows(messages, undefined, { level: "turn" }).find(isActivityFold)
    if (!fold) throw new Error("expected the transcript to fold one turn")
    return fold
}

function summaryOf(messages: UiMessage[]) {
    return summarizeActivityFold(turnFold(messages), indexPreEditCheckpointAttachments(messages))
}

const preEditCheckpoint = (ts: number, toolTs: number): UiMessage => ({
    ts,
    type: "say",
    say: "checkpoint_created",
    lastCheckpointHash: ["before-edit"],
    checkpointSource: { kind: "pre_edit", toolTs, toolName: "replace_in_file", dlineTid: `tool-${toolTs}` },
})

describe("summarizeActivityFold", () => {
    it("counts the tool calls, command, restore points and message of a finished turn", () => {
        const summary = summaryOf(finishedTurnTranscript)

        // Rounds open at the requests 11, 21, 31 and 41; readFile at 13, 33 and 34; searchFiles at 23;
        // the command at 42; thoughts at 12 and 22; restore points 10, 20, 30, 40; the text at 32.
        expect(Array.from(summary.toolCalls)).toEqual([
            ["readFile", 3],
            ["searchFiles", 1],
        ])
        expect(summary).toMatchObject({
            rounds: 4,
            commands: 1,
            fileEdits: 0,
            thoughts: 2,
            checkpoints: 4,
            assistantMessages: 1,
        })
        expect(describeActivityFold(summary)).toBe("4 rounds · 4 tool calls · 1 command · 2 thoughts · 4 checkpoints · 1 message")
        expect(describeToolCalls(summary)).toBe("readFile ×3, searchFiles ×1")
    })

    it("counts edits and working_respond updates apart from ordinary tool calls", () => {
        const summary = summaryOf([
            userTask(1, "Add the docs"),
            restorePoint(10, "files-1"),
            finishedRequest(11),
            editFile(12, "src/a.ts"),
            createFile(13, "docs/a.md"),
            workingRespond(14, "Both files are written."),
            finishedRequest(15),
            completion(16, "Done."),
        ])

        expect(summary.toolCalls.size).toBe(0)
        expect(summary).toMatchObject({ rounds: 1, commands: 0, fileEdits: 2, checkpoints: 1, assistantMessages: 1 })
        expect(describeActivityFold(summary)).toBe("1 round · 2 file edits · 1 checkpoint · 1 message")
    })

    it("counts a restore point attached to an edit once", () => {
        const summary = summaryOf([
            userTask(1, "Edit a file"),
            restorePoint(10, "files-1"),
            finishedRequest(11),
            editFile(12, "src/a.ts"),
            preEditCheckpoint(13, 12),
            finishedRequest(14),
            completion(15, "Done."),
        ])

        // The round's restore point at 10 and the pre-edit one at 13 that the edit card draws.
        expect(summary.checkpoints).toBe(2)
    })

    it("counts an MCP request once per call and not its response", () => {
        const mcpUse = (ts: number, use: Record<string, string>): UiMessage => ({
            ts,
            type: "say",
            say: "use_mcp_server",
            text: JSON.stringify(use),
        })
        const mcpResponse = (ts: number, requestTs: number): UiMessage => ({
            ts,
            type: "say",
            say: "mcp_server_response",
            text: JSON.stringify({ type: "mcp_server_response", requestTs, responses: ["ok"] }),
        })
        const summary = summaryOf([
            userTask(1, "Look it up"),
            restorePoint(10, "files-1"),
            finishedRequest(11),
            mcpUse(12, { serverName: "docs", type: "use_mcp_tool", toolName: "search", arguments: "{}" }),
            mcpResponse(13, 12),
            mcpUse(14, { serverName: "docs", type: "use_mcp_tool", toolName: "search", arguments: "{}" }),
            mcpResponse(15, 14),
            mcpUse(16, { serverName: "docs", type: "access_mcp_resource", uri: "docs://index" }),
            mcpResponse(17, 16),
            finishedRequest(18),
            completion(19, "Found it."),
        ])

        expect(Array.from(summary.toolCalls)).toEqual([
            ["docs:search", 2],
            ["docs:resource", 1],
        ])
        expect(describeActivityFold(summary)).toBe("1 round · 3 tool calls · 1 checkpoint")
    })

    it("counts a browser launch and each action as steps, not their results", () => {
        const browserResult = (ts: number): UiMessage => ({
            ts,
            type: "say",
            say: "browser_action_result",
            text: JSON.stringify({ currentUrl: "https://example.com" }),
        })
        const summary = summaryOf([
            userTask(1, "Check the page"),
            restorePoint(10, "files-1"),
            finishedRequest(11),
            { ts: 12, type: "say", say: "browser_action_launch", text: "https://example.com" },
            browserResult(13),
            { ts: 14, type: "say", say: "browser_action", text: JSON.stringify({ action: "click", coordinate: "5,5" }) },
            browserResult(15),
            { ts: 16, type: "say", say: "browser_action", text: JSON.stringify({ action: "close" }) },
            browserResult(17),
            finishedRequest(18),
            completion(19, "The page works."),
        ])

        expect(Array.from(summary.toolCalls)).toEqual([
            ["browser:launch", 1],
            ["browser:click", 1],
            ["browser:close", 1],
        ])
        expect(describeActivityFold(summary)).toBe("1 round · 3 tool calls · 1 checkpoint")
    })

    it("states no round count for a round fold", () => {
        const roundFold = turnFold(finishedTurnTranscript)._children.find(isActivityFold)
        if (!roundFold) throw new Error("expected the turn fold to hold round folds")

        const summary = summarizeActivityFold(roundFold, indexPreEditCheckpointAttachments(finishedTurnTranscript))

        // The first round: restore point 10, thought 12, readFile 13.
        expect(summary.rounds).toBeUndefined()
        expect(describeActivityFold(summary)).toBe("1 tool call · 1 thought · 1 checkpoint")
    })

    it("names a fold with nothing countable as finished steps", () => {
        expect(
            describeActivityFold({
                toolCalls: new Map(),
                commands: 0,
                fileEdits: 0,
                checkpoints: 0,
                thoughts: 0,
                assistantMessages: 0,
            }),
        ).toBe("Finished steps")
    })
})
