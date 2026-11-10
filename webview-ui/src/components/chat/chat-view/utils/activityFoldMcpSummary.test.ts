import { indexPreEditCheckpointAttachments } from "@shared/chat/drawnMessages"
import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { translateUi } from "@/i18n/messages"
import { completion, finishedRequest, userTask } from "../components/messages/activityFoldStoryFixtures"
import { describeActivityFoldParts, summarizeActivityFold } from "./activityFoldSummary"
import { isActivityFold } from "./chatRowKinds"
import { groupChatRows } from "./messageUtils"

const tool = (ts: number, serverName: string): UiMessage => ({
    ts,
    type: "say",
    say: "use_mcp_server",
    text: JSON.stringify({ serverName, type: "use_mcp_tool", toolName: "lookup", arguments: "{}" }),
})
const response = (ts: number, requestTs: number, isError?: boolean, text = "ok"): UiMessage => ({
    ts,
    type: "say",
    say: "mcp_server_response",
    text: JSON.stringify({ type: "mcp_server_response", requestTs, responses: [text], isError }),
})

function summarize(activity: UiMessage[]) {
    const messages = [
        userTask(1, "Query the MCP services"),
        finishedRequest(2),
        ...activity,
        finishedRequest(90),
        completion(100, "Complete."),
    ]
    const fold = groupChatRows(messages, undefined, { level: "user_turn" }).find(isActivityFold)
    if (!fold) throw new Error("Expected a completed user-turn fold")
    return { fold, summary: summarizeActivityFold(fold, indexPreEditCheckpointAttachments(messages)) }
}

describe("MCP fold summary", () => {
    it("counts servers and total tool requests once, with failures as a subset", () => {
        const { fold, summary } = summarize([
            tool(10, "docs"),
            response(11, 10, false),
            tool(20, "docs"),
            response(21, 20, true),
            response(22, 20, true),
            tool(30, "search"),
            response(31, 30, false),
            tool(40, "search"),
            response(41, 40, false),
            tool(50, "search"),
            response(51, 50, false),
            response(52, 999, true),
        ])
        expect(summary.mcp).toEqual({ servers: 2, tools: 5, failed: 1 })
        expect(summary.work.get("other") ?? 0).toBe(0)
        expect(Array.from(summary.tools)).toEqual([
            ["docs:lookup", 2],
            ["search:lookup", 3],
        ])
        expect(fold._failedMemberTs).toEqual(new Set([20]))
        expect(summary.failures.get("mcp")).toBe(1)
        expect(describeActivityFoldParts(summary).find((part) => part.kind === "mcp")).toEqual({
            kind: "mcp",
            text: "2 MCP (5 tools, 1 failed)",
            isFailure: true,
        })
        const chinese = describeActivityFoldParts(summary, (key, ...args) => translateUi("zh-CN", key, ...args))
        expect(chinese.find((part) => part.kind === "mcp")?.text).toBe("2 个 MCP（5 次工具调用，1 次失败）")
        expect(chinese.some((part) => part.kind === "failure.mcp")).toBe(false)
    })

    it("does not guess failures from legacy response prose", () => {
        const { summary } = summarize([tool(10, "docs"), response(11, 10, undefined, "Error:\nA quoted example, not a status")])
        expect(summary.mcp).toEqual({ servers: 1, tools: 1, failed: 0 })
        expect(summary.failures.size).toBe(0)
    })

    it("uses the latest explicit result for the same request without counting response updates", () => {
        const { summary } = summarize([tool(10, "docs"), response(11, 10, true), response(12, 10, false)])
        expect(summary.mcp).toEqual({ servers: 1, tools: 1, failed: 0 })
        expect(summary.failures.size).toBe(0)
    })
})
