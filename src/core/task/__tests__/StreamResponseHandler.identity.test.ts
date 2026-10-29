import { Logger } from "@shared/services/Logger"
import { describe, expect, it, vi } from "vitest"
import { StreamResponseHandler } from "../StreamResponseHandler"

describe("StreamResponseHandler identity propagation", () => {
    it("preserves canonical identities from stream delta to stored and runtime tool blocks", () => {
        const handler = new StreamResponseHandler(() => 123)
        const toolHandler = handler.getHandlers().toolUseHandler
        const identity = {
            function_id: "call_123",
            dline_tid: "dline_tid_123",
            provider_metadata: { item_id: "fc_item_123" },
        }

        toolHandler.processToolUseDelta(
            {
                type: "tool_use",
                name: "read_file",
                input: '{"path":"README.md"}',
            },
            identity,
        )

        const stored = toolHandler.getFinalizedToolUse("dline_tid_123")
        const runtime = toolHandler.getPartialToolUsesAsContent()[0]

        expect(stored).toMatchObject({
            function_id: "call_123",
            dline_tid: "dline_tid_123",
            provider_metadata: { item_id: "fc_item_123" },
        })
        expect(stored).not.toHaveProperty("id")
        expect(stored).not.toHaveProperty("call_id")
        expect(stored).not.toHaveProperty("item_id")
        expect(runtime).toMatchObject({
            function_id: "call_123",
            dline_tid: "dline_tid_123",
        })
        expect(runtime).not.toHaveProperty("call_id")
        expect(runtime).not.toHaveProperty("item_id")
    })

    it("logs each finalized function identity only once", () => {
        const debug = vi.spyOn(Logger, "debug")
        const handler = new StreamResponseHandler(() => 123)
        const toolHandler = handler.getHandlers().toolUseHandler
        toolHandler.processToolUseDelta(
            { type: "tool_use", name: "read_file", input: '{"path":"README.md"}' },
            { function_id: "call_once", dline_tid: "dline_tid_once", provider_metadata: {} },
        )

        toolHandler.getFinalizedToolUse("dline_tid_once")
        toolHandler.getFinalizedToolUse("dline_tid_once")

        expect(debug.mock.calls.filter(([message]) => message.includes("function_id=call_once"))).toHaveLength(1)
        debug.mockRestore()
    })
})
