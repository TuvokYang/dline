import { describe, expect, it, vi } from "vitest"
import { ClineDefaultTool } from "@/shared/tools"
import { ActModeRespondHandler } from "../ActModeRespondHandler"

describe("ActModeRespondHandler", () => {
    it("streams the canonical tool row shape used by the final response", async () => {
        const say = vi.fn(async () => undefined)
        const handler = new ActModeRespondHandler()

        await handler.handlePartialBlock(
            {
                name: ClineDefaultTool.ACT_MODE,
                ts: 101,
                params: { response: "Work in progress" },
            } as any,
            {
                removeClosingTag: () => "Work in progress",
                say,
            } as any,
        )

        expect(say).toHaveBeenCalledWith(
            "tool",
            JSON.stringify({ tool: "actModeRespond", content: "Work in progress" }),
            undefined,
            undefined,
            true,
            101,
        )
    })
})
