import { describe, expect, it } from "vitest"
import { channelOfRuntimeEvent } from "../event-routes"

describe("channelOfRuntimeEvent (WS-109 SC-1)", () => {
    it("puts a reported failure on the error channel and everything else on the runtime channel", () => {
        const channels = Object.fromEntries(
            [
                "api.request.failed",
                "tool.execution.failed",
                "subagent.run.failed",
                "mcp.tools.call.failed",
                "extension.error",
                "runtime.heap_growth_bytes.breach",
                "task.error",
                "extension.warning",
                "api.request.cancelled",
            ].map((name) => [name, channelOfRuntimeEvent(name)]),
        )

        expect(channels).toEqual({
            "api.request.failed": "error",
            "tool.execution.failed": "error",
            "subagent.run.failed": "error",
            "mcp.tools.call.failed": "error",
            "extension.error": "error",
            "runtime.heap_growth_bytes.breach": "runtime",
            "task.error": "runtime",
            "extension.warning": "runtime",
            "api.request.cancelled": "runtime",
        })
    })
})
