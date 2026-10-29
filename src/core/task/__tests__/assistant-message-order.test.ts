import { strict as assert } from "node:assert"
import type { AssistantMessageContent, ToolUse } from "@core/assistant-message"
import { DlineDefaultTool } from "@shared/tools"
import { describe, it } from "vitest"
import { isTurnEndingToolName, orderTurnEndingContentBlocks, orderTurnEndingNativeToolBlocks } from "../assistant-message-order"

const tool = (name: DlineDefaultTool, functionId = `function-${name}`): ToolUse => ({
    type: "tool_use",
    name,
    params: {},
    partial: false,
    function_id: functionId,
    dline_tid: `tid-${functionId}`,
    ts: Date.now(),
})

describe("assistant message tool ordering", () => {
    it("moves attempt_completion after regular tool uses", () => {
        const write = tool(DlineDefaultTool.FILE_NEW)
        const attempt = tool(DlineDefaultTool.ATTEMPT)

        const ordered = orderTurnEndingContentBlocks([attempt, write])

        assert.deepEqual(ordered, [write, attempt])
    })

    it("moves ask_followup_question after regular tool uses", () => {
        const ask = tool(DlineDefaultTool.ASK)
        const read = tool(DlineDefaultTool.FILE_READ)

        const ordered = orderTurnEndingContentBlocks([ask, read])

        assert.deepEqual(ordered, [read, ask])
    })

    it("moves make_plan with needs_more_exploration after regular tool uses", () => {
        const plan = {
            ...tool(DlineDefaultTool.MAKE_PLAN),
            params: { needs_more_exploration: "true" },
        } satisfies ToolUse
        const search = tool(DlineDefaultTool.SEARCH)

        const ordered = orderTurnEndingContentBlocks([plan, search])

        assert.deepEqual(ordered, [search, plan])
    })

    it("keeps content unchanged when no turn-ending tool is followed by more content", () => {
        const text = { type: "text", content: "Done", partial: false, ts: Date.now() } satisfies AssistantMessageContent
        const read = tool(DlineDefaultTool.FILE_READ)
        const attempt = tool(DlineDefaultTool.ATTEMPT)
        const blocks = [text, read, attempt]

        const ordered = orderTurnEndingContentBlocks(blocks)

        assert.equal(ordered, blocks)
    })

    it("orders native tool blocks without dropping function ids", () => {
        const attempt = {
            type: "tool_use",
            function_id: "call-attempt",
            dline_tid: "tid-attempt",
            name: DlineDefaultTool.ATTEMPT,
            input: {},
        } as const
        const write = {
            type: "tool_use",
            function_id: "call-write",
            dline_tid: "tid-write",
            name: DlineDefaultTool.FILE_NEW,
            input: {},
        } as const

        const ordered = orderTurnEndingNativeToolBlocks([attempt, write])

        assert.deepEqual(
            ordered.map((block) => block.function_id),
            ["call-write", "call-attempt"],
        )
    })

    it("recognizes all turn-ending tool names", () => {
        assert.equal(isTurnEndingToolName(DlineDefaultTool.ATTEMPT), true)
        assert.equal(isTurnEndingToolName(DlineDefaultTool.ASK), true)
        assert.equal(isTurnEndingToolName(DlineDefaultTool.MAKE_PLAN), true)
        assert.equal(isTurnEndingToolName(DlineDefaultTool.NEW_TASK), true)
        assert.equal(isTurnEndingToolName(DlineDefaultTool.FILE_READ), false)
    })
})
