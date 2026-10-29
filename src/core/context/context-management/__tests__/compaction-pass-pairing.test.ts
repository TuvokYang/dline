import { convertToOpenAIResponsesInput } from "@core/api/transform/openai-response-format"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { createCompactionSourceSnapshot } from "../compaction-source-snapshot"
import { indexLogicalTurns } from "../logical-turns"
import { buildCompactionPassHistoryForRange, startTargetWindowFitting } from "../target-window-fitting"

/**
 * Regression guard for `400 No tool output found for function call fc_...`.
 *
 * A tagged conversational tool result starts the next user-authored round, so the
 * previous logical turn ends with a `tool_use` whose result lives in the following
 * round. When a hidden compaction Pass covers only the previous turn, the projected
 * Responses request must never contain a `function_call` without its output.
 */

function textMessage(role: "user" | "assistant", text: string): ClineStorageMessage {
    return { role, content: [{ type: "text", text }] }
}

function toolUse(functionId: string, name: string): ClineStorageMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_use", function_id: functionId, dline_tid: `tid-${functionId}`, name, input: {} }],
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

/** Reproduce the exact canonical shape recorded at api indexes 179/180 of task 1787923017605. */
function createTaggedFeedbackHistory(): ClineStorageMessage[] {
    return [
        textMessage("user", "<task>Refactor the language rules</task>"),
        toolUse("call_ClqKYdfhn2EQ96FhGa6slahO", "attempt_completion"),
        toolResult(
            "call_ClqKYdfhn2EQ96FhGa6slahO",
            "[attempt_completion] Result: Done\n<feedback>\nStart the memory bank change, give me the plan first\n</feedback>",
        ),
        toolUse("call_next_round", "read_file"),
        toolResult("call_next_round", "file contents"),
    ]
}

function collectPassIdentities(input: readonly unknown[]): { callIds: string[]; outputIds: string[] } {
    const callIds: string[] = []
    const outputIds: string[] = []
    for (const item of input as Array<{ type?: string; call_id?: string }>) {
        if (item.type === "function_call" && item.call_id) callIds.push(item.call_id)
        if (item.type === "function_call_output" && item.call_id) outputIds.push(item.call_id)
    }
    return { callIds, outputIds }
}

describe("compaction Pass provider pairing", () => {
    it("indexes the tagged conversational result as the next round", () => {
        const history = createTaggedFeedbackHistory()

        const index = indexLogicalTurns(history)

        // The first turn ends at the assistant tool_use; its result opens the next round.
        expect(index.turns[0]).toMatchObject({ startMessageIndex: 0, endMessageIndex: 1 })
        expect(index.turns.length).toBeGreaterThan(1)
    })

    it("never projects a function_call without its output for a single-turn Pass", () => {
        const history = createTaggedFeedbackHistory()
        const snapshot = createCompactionSourceSnapshot(history)
        const state = startTargetWindowFitting(indexLogicalTurns(history), "operation-pairing", snapshot)

        // Pass 0 covers only the first logical turn, exactly as the planner selected in production.
        const passHistory = buildCompactionPassHistoryForRange(state, 0, 0)
        const { input } = convertToOpenAIResponsesInput(passHistory)
        const { callIds, outputIds } = collectPassIdentities(input)

        const diagnostic = JSON.stringify({ callIds, outputIds, input }, null, 2)
        const missingOutputIds = callIds.filter((callId) => !outputIds.includes(callId))
        expect(missingOutputIds, diagnostic).toEqual([])
    })

    it("never projects a function_call without its output for any planner Pass range", () => {
        const history = createTaggedFeedbackHistory()
        const snapshot = createCompactionSourceSnapshot(history)
        const index = indexLogicalTurns(history)
        const state = startTargetWindowFitting(index, "operation-pairing-matrix", snapshot)

        for (let endTurnIndex = 0; endTurnIndex < index.turns.length; endTurnIndex++) {
            const passHistory = buildCompactionPassHistoryForRange(state, 0, endTurnIndex)
            const { input } = convertToOpenAIResponsesInput(passHistory)
            const { callIds, outputIds } = collectPassIdentities(input)
            const missingOutputIds = callIds.filter((callId) => !outputIds.includes(callId))
            expect(missingOutputIds, `Pass range 0..${endTurnIndex}: ${JSON.stringify(input)}`).toEqual([])
        }
    })
})
