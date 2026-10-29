import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { indexLogicalTurns, type LogicalTurnSpan, splitLogicalTurnAtMessageBoundaries } from "../logical-turns"

function textMessage(role: "user" | "assistant", text: string): ClineStorageMessage {
    return { role, content: [{ type: "text", text }] }
}

function toolUse(functionId: string, name = "qna_respond"): ClineStorageMessage {
    return {
        role: "assistant",
        content: [
            {
                type: "tool_use",
                function_id: functionId,
                dline_tid: `tid-${functionId}`,
                name,
                input: {},
            },
        ],
    }
}

function toolResult(functionId: string, text: string): ClineStorageMessage {
    return {
        role: "user",
        content: [
            {
                type: "tool_result",
                function_id: functionId,
                dline_tid: `tid-${functionId}`,
                content: [{ type: "text", text }],
            },
        ],
    }
}

function serialized(messages: readonly ClineStorageMessage[]): string {
    return JSON.stringify(messages)
}

function spanMessages(history: readonly ClineStorageMessage[], span: LogicalTurnSpan): readonly ClineStorageMessage[] {
    return history.slice(span.startMessageIndex, span.endMessageIndex + 1)
}

describe("logical turn indexing", () => {
    it("indexes ordinary user and assistant exchanges as stable complete turns", () => {
        const history = [
            textMessage("user", "<task>Turn A</task>"),
            textMessage("assistant", "Response A"),
            textMessage("user", "<user_message>Turn B</user_message>"),
            textMessage("assistant", "Response B"),
        ]

        const result = indexLogicalTurns(history)

        expect(result.turns.map(({ startMessageIndex, endMessageIndex }) => [startMessageIndex, endMessageIndex])).toEqual([
            [0, 1],
            [2, 3],
        ])
        expect(result.protectedStartMessageIndex).toBe(history.length)
        expect(result).not.toHaveProperty("protectedTail")
        expect(result.turns[0]).not.toHaveProperty("messages")
        expect(result.issues).toEqual([])
    })

    it("keeps each assistant tool use and matching result in one atomic turn", () => {
        const history = [
            textMessage("user", "<task>Read the file</task>"),
            toolUse("call-read", "read_file"),
            toolResult("call-read", "File contents"),
            textMessage("assistant", "The file has been read."),
        ]

        const result = indexLogicalTurns(history)

        expect(result.turns).toHaveLength(1)
        expect(result.turns[0]).toMatchObject({
            startMessageIndex: 0,
            endMessageIndex: 3,
            functionIds: ["call-read"],
        })
        expect(serialized(spanMessages(history, result.turns[0]))).toContain("File contents")
        expect(result.protectedStartMessageIndex).toBe(history.length)
        expect(result.turns[0]).not.toHaveProperty("messages")
    })

    it("starts tagged Q&A feedback as the protected next round", () => {
        const history = [
            textMessage("user", "<task>Turn A</task>"),
            toolUse("call-a"),
            toolResult("call-a", "[qna_respond] Result:\n<feedback>Turn B request</feedback>"),
            toolUse("call-b"),
            toolResult("call-b", "[qna_respond] Result:\n<feedback>Turn C request</feedback>"),
        ]

        const result = indexLogicalTurns(history)

        expect(
            result.turns.map(({ startMessageIndex, endMessageIndex, functionIds }) => ({
                startMessageIndex,
                endMessageIndex,
                functionIds,
            })),
        ).toEqual([
            { startMessageIndex: 0, endMessageIndex: 1, functionIds: ["call-a"] },
            { startMessageIndex: 2, endMessageIndex: 3, functionIds: ["call-a", "call-b"] },
        ])
        expect(result.protectedStartMessageIndex).toBe(4)
        expect(serialized(spanMessages(history, result.turns[0]))).not.toContain("Turn B request")
        expect(serialized(spanMessages(history, result.turns[1]))).toContain("Turn B request")
        expect(serialized(history.slice(result.protectedStartMessageIndex))).toContain("Turn C request")
        expect(result).not.toHaveProperty("protectedTail")
    })

    // The journal keeps an input and the environment snapshot sent with it as
    // separate messages. They are one round: splitting them made the reply that
    // opens a round a turn of its own, so a Pass could summarize the user's
    // words while the answer to them went into the next Pass.
    it("keeps consecutive user messages before the answer in one round", () => {
        const history = [
            textMessage("user", "<task>Turn A</task>"),
            textMessage("user", "# Environment A"),
            toolUse("call-a"),
            toolResult("call-a", "[qna_respond] Result:\n<feedback>Turn B request</feedback>"),
            textMessage("user", "# Environment B"),
            toolUse("call-b"),
            toolResult("call-b", "[qna_respond] Result:\n<feedback>Turn C request</feedback>"),
        ]

        const result = indexLogicalTurns(history)

        expect(result.turns.map(({ startMessageIndex, endMessageIndex }) => [startMessageIndex, endMessageIndex])).toEqual([
            [0, 2],
            [3, 5],
        ])
        expect(serialized(spanMessages(history, result.turns[1]))).toContain("Turn B request")
        expect(serialized(spanMessages(history, result.turns[1]))).toContain("# Environment B")
        expect(result.protectedStartMessageIndex).toBe(6)
    })

    it("keeps parallel ordinary tool results atomic when their payload contains user-content tags", () => {
        const history: ClineStorageMessage[] = [
            textMessage("user", "<task>Inspect the implementation</task>"),
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        function_id: "call-read-a",
                        dline_tid: "tid-call-read-a",
                        name: "read_file",
                        input: {},
                    },
                    {
                        type: "tool_use",
                        function_id: "call-read-b",
                        dline_tid: "tid-call-read-b",
                        name: "read_file",
                        input: {},
                    },
                ],
            },
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        function_id: "call-read-a",
                        dline_tid: "tid-call-read-a",
                        content: [{ type: "text", text: 'prompt_1: "<task>E2E_BATCH_CANCEL_ONE</task>"' }],
                    },
                    {
                        type: "tool_result",
                        function_id: "call-read-b",
                        dline_tid: "tid-call-read-b",
                        content: [{ type: "text", text: "const sample = '<feedback>fixture</feedback>'" }],
                    },
                ],
            },
        ]

        const result = indexLogicalTurns(history)

        expect(result.turns).toHaveLength(1)
        expect(result.turns[0]).toMatchObject({
            startMessageIndex: 0,
            endMessageIndex: 2,
            functionIds: ["call-read-a", "call-read-b"],
        })
        expect(result.protectedStartMessageIndex).toBe(history.length)
        expect(result.issues).toEqual([])
    })

    it("protects an incomplete tool-use tail instead of exposing it as a compressible turn", () => {
        const completeTurn = [textMessage("user", "<task>Complete</task>"), textMessage("assistant", "Complete response")]
        const incompleteTail = [
            textMessage("user", "<user_message>Pending</user_message>"),
            toolUse("call-pending", "write_to_file"),
        ]

        const history = [...completeTurn, ...incompleteTail]
        const result = indexLogicalTurns(history)

        expect(result.turns).toHaveLength(1)
        expect(result.protectedStartMessageIndex).toBe(2)
        expect(history.slice(result.protectedStartMessageIndex)).toEqual(incompleteTail)
        expect(result.issues).toEqual([{ kind: "unpaired_tool_use", messageIndex: 3, functionId: "call-pending" }])
    })

    it("closes a turn whose paired tool result is the final message", () => {
        const history = [
            textMessage("user", "<task>Ask a question</task>"),
            toolUse("call-a"),
            toolResult("call-a", "plain tool output without feedback tags"),
        ]

        const result = indexLogicalTurns(history)

        expect(result.turns.map(({ startMessageIndex, endMessageIndex }) => [startMessageIndex, endMessageIndex])).toEqual([
            [0, 2],
        ])
        expect(result.turns[0]).toMatchObject({ functionIds: ["call-a"] })
        expect(result.protectedStartMessageIndex).toBe(history.length)
        expect(result.issues).toEqual([])
    })

    it("protects an unpaired tool-use after an earlier completed tool turn", () => {
        const history = [
            textMessage("user", "<task>Read files</task>"),
            toolUse("call-seed", "read_file"),
            toolResult("call-seed", "large seed result"),
            toolUse("call-protected", "read_file"),
        ]

        const result = indexLogicalTurns(history)

        expect(result.turns.map(({ startMessageIndex, endMessageIndex }) => [startMessageIndex, endMessageIndex])).toEqual([
            [0, 2],
        ])
        expect(result.protectedStartMessageIndex).toBe(3)
        expect(history.slice(result.protectedStartMessageIndex)).toEqual([history[3]])
        expect(result.issues).toEqual([{ kind: "unpaired_tool_use", messageIndex: 3, functionId: "call-protected" }])
    })

    it("keeps a plain assistant continuation in the completed tool turn", () => {
        const history = [
            textMessage("user", "<task>Ask a question</task>"),
            toolUse("call-a"),
            toolResult("call-a", "plain tool output without feedback tags"),
            textMessage("assistant", "The tool result has been processed."),
        ]

        const result = indexLogicalTurns(history)

        expect(result.turns.map(({ startMessageIndex, endMessageIndex }) => [startMessageIndex, endMessageIndex])).toEqual([
            [0, 3],
        ])
        expect(result.protectedStartMessageIndex).toBe(history.length)
        expect(result.issues).toEqual([])
    })

    it("protects an orphan result and reports its canonical function identity", () => {
        const orphan = toolResult("call-orphan", "orphan")
        const history: ClineStorageMessage[] = [
            textMessage("user", "<task>Complete</task>"),
            textMessage("assistant", "Complete response"),
            orphan,
        ]

        const result = indexLogicalTurns(history)

        expect(result.turns).toHaveLength(1)
        expect(history.slice(result.protectedStartMessageIndex)).toEqual([orphan])
        expect(result.issues).toEqual([{ kind: "orphan_tool_result", messageIndex: 2, functionId: "call-orphan" }])
    })

    it.each([
        "plain second request",
        "<environment_details>dynamic state</environment_details>",
        "# task_progress recommended\n- [ ] next step",
        "# TODO LIST UPDATE: checklist changed",
    ])("uses the same logical-turn boundary for every non-empty canonical user text: %s", (secondUserText) => {
        const history = [
            textMessage("user", "first request"),
            textMessage("assistant", "first response"),
            textMessage("user", secondUserText),
            textMessage("assistant", "second response"),
        ]

        const result = indexLogicalTurns(history)

        expect(result.turns.map(({ startMessageIndex, endMessageIndex }) => [startMessageIndex, endMessageIndex])).toEqual([
            [0, 1],
            [2, 3],
        ])
        expect(result.protectedStartMessageIndex).toBe(history.length)
    })

    it("splits a turn only at message boundaries where no tool use is open", () => {
        const twoResults: ClineStorageMessage = {
            role: "user",
            content: [
                { type: "tool_result", function_id: "call-b", dline_tid: "tid-call-b", content: [{ type: "text", text: "B" }] },
            ],
        }
        const history: ClineStorageMessage[] = [
            textMessage("user", "large request"),
            {
                role: "assistant",
                content: [
                    { type: "tool_use", function_id: "call-a", dline_tid: "tid-call-a", name: "read_file", input: {} },
                    { type: "tool_use", function_id: "call-b", dline_tid: "tid-call-b", name: "read_file", input: {} },
                ],
            },
            toolResult("call-a", "A"),
            twoResults,
            textMessage("assistant", "done"),
        ]
        const [turn] = indexLogicalTurns(history).turns

        const segments = splitLogicalTurnAtMessageBoundaries(history, turn)

        // The tool uses stay with both of their results; every message is kept exactly once.
        expect(segments.map(({ startMessageIndex, endMessageIndex }) => [startMessageIndex, endMessageIndex])).toEqual([
            [0, 0],
            [1, 3],
            [4, 4],
        ])
        expect(segments[1]?.functionIds).toEqual(["call-a", "call-b"])
        expect(serialized(segments.flatMap((segment) => spanMessages(history, segment)))).toBe(serialized(history))
    })

    it("returns one segment for a turn that cannot be split further", () => {
        const history = [toolUse("call-only", "read_file"), toolResult("call-only", "result")]
        const turn: LogicalTurnSpan = { id: "turn", startMessageIndex: 0, endMessageIndex: 1, functionIds: ["call-only"] }

        expect(splitLogicalTurnAtMessageBoundaries(history, turn)).toHaveLength(1)
    })
})
