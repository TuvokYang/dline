import { indexPreEditCheckpointAttachments } from "@shared/chat/drawnMessages"
import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { translateUi } from "@/i18n/messages"
import {
    completion,
    createFile,
    editFile,
    finishedRequest,
    finishedTurnTranscript,
    restorePoint,
    subagentBatch,
    userTask,
    workingRespond,
} from "../components/messages/activityFoldStoryFixtures"
import {
    type ActivityFoldSummary,
    describeActivityFold,
    describeActivityFoldParts,
    describeFoldDetail,
    describeToolCalls,
    summarizeActivityFold,
} from "./activityFoldSummary"
import { type ActivityFold, isActivityFold } from "./chatRowKinds"
import { groupChatRows } from "./messageUtils"

function turnFold(messages: UiMessage[]): ActivityFold {
    const fold = groupChatRows(messages, undefined, { level: "user_turn" }).find(isActivityFold)
    if (!fold) throw new Error("expected the transcript to fold one turn")
    return fold
}

function summaryOf(messages: UiMessage[]) {
    return summarizeActivityFold(turnFold(messages), indexPreEditCheckpointAttachments(messages))
}

function summaryOfRoots(messages: UiMessage[], workspaceRoots: readonly string[]) {
    return summarizeActivityFold(turnFold(messages), indexPreEditCheckpointAttachments(messages), { workspaceRoots })
}

/** A command row states the directory it runs in after the command line. */
const commandAsk = (ts: number, commandLine: string, workingDirectory: string): UiMessage => ({
    ts,
    type: "say",
    say: "command",
    text: `${commandLine}\n\nWorking directory: ${workingDirectory}`,
})

const preEditCheckpoint = (ts: number, toolTs: number): UiMessage => ({
    ts,
    type: "say",
    say: "checkpoint_created",
    lastCheckpointHash: ["before-edit"],
    checkpointSource: { kind: "pre_edit", toolTs, toolName: "replace_in_file", dlineTid: `tool-${toolTs}` },
})

const writeTool = (ts: number, tool: string): UiMessage => ({
    ts,
    type: "say",
    say: "tool",
    text: JSON.stringify({ tool, path: "src/a.ts" }),
})

describe("summarizeActivityFold", () => {
    it("counts a whole turn including prose, using actual requests rather than nested wrappers", () => {
        const summary = summaryOf(finishedTurnTranscript)
        expect(summary).toMatchObject({ rounds: 4, thoughts: 2, checkpoints: 4, assistantMessages: 1 })
        expect(summary.work.get("read")).toBe(4)
        expect(summary.work.get("command")).toBe(1)
        expect(Array.from(summary.tools)).toEqual([
            ["readFile", 3],
            ["searchFiles", 1],
        ])
        expect(describeToolCalls(summary)).toBe("readFile ×3, searchFiles ×1")
    })

    /**
     * The header states a verb for every write, so a reader can see a rename or a
     * delete instead of an anonymous count. A write that fell into a generic
     * bucket would make destructive work look like a lookup.
     */
    it("states every write tool as a write rather than an unnamed call", () => {
        const summary = summaryOf([
            userTask(1, "Tidy the module"),
            restorePoint(10, "files-1"),
            finishedRequest(11),
            writeTool(12, "editedExistingFile"),
            writeTool(13, "newFileCreated"),
            writeTool(14, "fileDeleted"),
            writeTool(15, "renameSymbol"),
            writeTool(16, "replaceText"),
            finishedRequest(17),
            completion(18, "Done."),
        ])

        expect(summary.work.get("write")).toBe(5)
        expect(summary.work.get("other")).toBeUndefined()
        expect(describeActivityFold(summary)).toBe("1 round · 5 file edits · 1 checkpoint")
    })

    /**
     * A subagent batch is its own kind of work. Counting it as tool calls is the
     * defect this test exists for: delegation would disappear into the tools the
     * agents happened to run.
     */
    it("states a subagent batch as subagents and never as tool calls", () => {
        const summary = summaryOf([
            userTask(1, "Review the parser"),
            restorePoint(10, "files-1"),
            finishedRequest(11),
            subagentBatch(12, "completed"),
            finishedRequest(13),
            completion(14, "Reviewed."),
        ])

        expect(summary.work.get("subagent")).toBe(1)
        expect(summary.work.get("read")).toBeUndefined()
        expect(summary.work.get("other")).toBeUndefined()
        expect(describeActivityFold(summary)).toBe("1 round · 1 subagent · 1 checkpoint")
    })

    it("names the agents a batch ran so the header can say what delegated", () => {
        const batch: UiMessage = {
            ts: 12,
            type: "say",
            say: "subagent",
            text: JSON.stringify({
                status: "completed",
                total: 2,
                completed: 2,
                successes: 2,
                failures: 0,
                toolCalls: 9,
                inputTokens: 0,
                outputTokens: 0,
                contextWindow: 0,
                maxContextTokens: 0,
                maxContextUsagePercentage: 0,
                items: [
                    { index: 0, prompt: "a", status: "completed", subagentName: "reviewer" },
                    { index: 1, prompt: "b", status: "completed", subagentName: "explorer" },
                ],
            }),
        }
        const summary = summaryOf([
            userTask(1, "Review the parser"),
            restorePoint(10, "files-1"),
            finishedRequest(11),
            batch,
            finishedRequest(13),
            completion(14, "Reviewed."),
        ])

        expect(summary.work.get("subagent")).toBe(2)
        expect(Array.from(summary.subagents)).toEqual([
            ["reviewer", 1],
            ["explorer", 1],
        ])
        expect(describeFoldDetail(summary)).toContain("reviewer ×1")
    })

    it("counts edits and the working_respond update inside the turn block", () => {
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

        expect(summary.tools.size).toBe(2)
        expect(summary).toMatchObject({ rounds: 1, checkpoints: 1, assistantMessages: 1 })
        expect(summary.work.get("write")).toBe(2)
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

        expect(Array.from(summary.tools)).toEqual([
            ["docs:search", 2],
            ["docs:resource", 1],
        ])
        // A server call is neither a workspace file operation nor a shell command,
        // so it is neither a `file read` nor an external one.
        expect(Array.from(summary.work)).toEqual([["other", 3]])
        expect(summary.external.size).toBe(0)
        expect(describeActivityFold(summary)).toBe("1 round · 3 others · 1 checkpoint")
    })

    it("states the external share inside the verb it qualified", () => {
        const summary = summaryOf([
            userTask(1, "Read locally and elsewhere"),
            restorePoint(10, "files-1"),
            finishedRequest(11),
            writeTool(12, "readFile"),
            finishedRequest(13),
            writeTool(14, "findReferences"),
            finishedRequest(15),
            writeTool(16, "webFetch"),
            finishedRequest(17),
            writeTool(18, "codeExecution"),
            finishedRequest(19),
            completion(20, "Read them."),
        ])

        // Two file reads, one of which left the workspace. A web fetch is its own
        // kind and never external; code execution runs a command outside the
        // workspace rather than reading one.
        expect(summary.work.get("read")).toBe(2)
        expect(summary.work.get("command")).toBe(1)
        expect(summary.work.get("web")).toBe(1)
        expect(summary.external.get("read")).toBe(1)
        expect(summary.external.get("command")).toBe(1)
        expect(describeActivityFold(summary)).toBe(
            "4 rounds · 2 file reads (1 external) · 1 cmd (1 external) · 1 web tools · 1 checkpoint",
        )
    })

    it("counts a command that ran outside every workspace root as external", () => {
        const summary = summaryOfRoots(
            [
                userTask(1, "Run it elsewhere"),
                restorePoint(10, "files-1"),
                finishedRequest(11),
                commandAsk(12, "npm install", "E:\\workspace\\vscode\\dline"),
                finishedRequest(13),
                commandAsk(14, "npm test", "E:\\workspace\\other"),
                finishedRequest(15),
                completion(16, "Ran them."),
            ],
            ["E:\\workspace\\vscode\\dline"],
        )

        // Two commands ran, and only the second left the workspace.
        expect(summary.work.get("command")).toBe(2)
        expect(summary.external.get("command")).toBe(1)
        expect(describeActivityFold(summary)).toBe("2 rounds · 2 cmds (1 external) · 1 checkpoint")
    })

    it("counts a command as internal when its directory is a subdirectory of a root", () => {
        const summary = summaryOfRoots(
            [
                userTask(1, "Run it here"),
                restorePoint(10, "files-1"),
                finishedRequest(11),
                commandAsk(12, "npm test", "e:\\workspace\\vscode\\dline\\src"),
                finishedRequest(13),
                completion(14, "Ran it."),
            ],
            ["E:\\workspace\\vscode\\dline"],
        )

        // Separator, trailing-slash and case differences do not make a nested
        // directory external.
        expect(summary.external.get("command")).toBeUndefined()
        expect(describeActivityFold(summary)).toBe("1 round · 1 cmd · 1 checkpoint")
    })

    it("never reports a command without a recorded directory as external", () => {
        const summary = summaryOfRoots(
            [
                userTask(1, "Run it"),
                restorePoint(10, "files-1"),
                finishedRequest(11),
                { ts: 12, type: "say", say: "command", text: "npm test" },
                finishedRequest(13),
                completion(14, "Ran it."),
            ],
            ["E:\\workspace\\vscode\\dline"],
        )

        // An older row states no directory, so the block cannot claim it left the
        // workspace even though the command may have.
        expect(summary.work.get("command")).toBe(1)
        expect(summary.external.get("command")).toBeUndefined()
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

        expect(Array.from(summary.tools)).toEqual([
            ["browser:launch", 1],
            ["browser:click", 1],
            ["browser:close", 1],
        ])
        // A browser step is driven through the browser, so it is counted apart
        // from file reads and is never external.
        expect(summary.work.get("browser")).toBe(3)
        expect(summary.external.size).toBe(0)
        expect(describeActivityFold(summary)).toBe("1 round · 3 browsers · 1 checkpoint")
    })

    it("counts distinct requests in message segments too", () => {
        const folds = groupChatRows(finishedTurnTranscript, undefined, { level: "message_segment" }).filter(isActivityFold)
        expect(folds.map((fold) => summarizeActivityFold(fold, new Map()).rounds)).toEqual([2, 2])
    })

    it("gives every fact a unique semantic identity independent of translation and counts", () => {
        const summary: ActivityFoldSummary = {
            rounds: 2,
            work: new Map([
                ["read", 1],
                ["write", 2],
                ["command", 3],
                ["subagent", 4],
                ["web", 5],
                ["browser", 6],
                ["other", 7],
            ]),
            external: new Map([
                ["read", 1],
                ["command", 2],
            ]),
            tools: new Map(),
            subagents: new Map(),
            thoughts: 2,
            checkpoints: 3,
            assistantMessages: 4,
            failures: new Map([
                ["edit", 1],
                ["read", 2],
                ["subagent", 3],
                ["command", 4],
                ["web", 5],
                ["browser", 6],
            ]),
        }
        const expectedKinds = [
            "rounds",
            "work.read",
            "work.write",
            "work.command",
            "work.subagent",
            "work.web",
            "work.browser",
            "work.other",
            "thoughts",
            "checkpoints",
            "messages",
            "failure.edit",
            "failure.read",
            "failure.subagent",
            "failure.command",
            "failure.web",
            "failure.browser",
        ]
        const english = describeActivityFoldParts(summary)
        const chinese = describeActivityFoldParts(summary, (key, ...args) => translateUi("zh-CN", key, ...args))
        const changedCounts = describeActivityFoldParts({
            ...summary,
            rounds: 3,
            work: new Map(Array.from(summary.work, ([kind, count]) => [kind, count + 1])),
            external: new Map(),
        })
        const sameText = describeActivityFoldParts(summary, () => "same translation")
        for (const parts of [english, chinese, changedCounts, sameText]) {
            expect(parts.map((part) => part.kind)).toEqual(expectedKinds)
            expect(new Set(parts.map((part) => part.kind)).size).toBe(parts.length)
            expect(parts.filter((part) => part.isFailure).map((part) => part.kind)).toEqual(expectedKinds.slice(-6))
        }
        expect(chinese.map((part) => part.text)).not.toEqual(english.map((part) => part.text))
        expect(changedCounts.map((part) => part.text)).not.toEqual(english.map((part) => part.text))
    })

    it("keeps the fallback fact's identity when translated", () => {
        const summary: ActivityFoldSummary = {
            work: new Map(),
            external: new Map(),
            tools: new Map(),
            subagents: new Map(),
            failures: new Map(),
            checkpoints: 0,
            thoughts: 0,
            assistantMessages: 0,
        }
        const english = describeActivityFoldParts(summary)
        const chinese = describeActivityFoldParts(summary, (key, ...args) => translateUi("zh-CN", key, ...args))
        expect(english).toEqual([{ kind: "finished", text: "Finished steps", isFailure: false }])
        expect(chinese).toEqual([{ kind: "finished", text: "已完成的步骤", isFailure: false }])
    })

    it("names a fold with nothing countable as finished steps", () => {
        expect(
            describeActivityFold({
                work: new Map(),
                external: new Map(),
                tools: new Map(),
                subagents: new Map(),
                checkpoints: 0,
                thoughts: 0,
                assistantMessages: 0,
            }),
        ).toBe("Finished steps")
    })
})
