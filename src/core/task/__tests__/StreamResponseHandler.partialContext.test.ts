import { describe, expect, it } from "vitest"
import { StreamResponseHandler } from "../StreamResponseHandler"

describe("StreamResponseHandler partial tool params", () => {
    it("streams an unclosed summarize_task context into partial params while the model is still generating it", () => {
        const handler = new StreamResponseHandler(() => 200)
        const toolHandler = handler.getHandlers().toolUseHandler
        const identity = { function_id: "call_sum", dline_tid: "dline_tid_sum", provider_metadata: {} }

        // OpenAI-compatible streams accumulate arguments fragments; the long
        // `context` string stays unclosed until the very end of the tool call.
        toolHandler.processToolUseDelta({ type: "tool_use", name: "summarize_task", input: '{"context":"The user' }, identity)
        const earlyPartial = toolHandler.getPartialToolUsesAsContent()[0]
        expect(earlyPartial?.params).toMatchObject({ context: "The user" })

        toolHandler.processToolUseDelta(
            { type: "tool_use", name: "summarize_task", input: " wants to fix the web tools auth issue" },
            identity,
        )
        const grownPartial = toolHandler.getPartialToolUsesAsContent()[0]
        expect(grownPartial?.params).toMatchObject({ context: "The user wants to fix the web tools auth issue" })
    })

    it("extracts a closed context value before trailing unclosed fields", () => {
        const handler = new StreamResponseHandler(() => 200)
        const toolHandler = handler.getHandlers().toolUseHandler
        const identity = { function_id: "call_sum2", dline_tid: "dline_tid_sum2", provider_metadata: {} }

        toolHandler.processToolUseDelta(
            {
                type: "tool_use",
                name: "summarize_task",
                input: '{"context":"complete summary","foo":"bar',
            },
            identity,
        )
        const partial = toolHandler.getPartialToolUsesAsContent()[0]
        expect(partial?.params).toMatchObject({ context: "complete summary" })
    })
})
