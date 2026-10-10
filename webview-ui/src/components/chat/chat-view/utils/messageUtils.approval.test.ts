import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { filterVisibleMessages, getToolsNotInCurrentActivities, groupLowStakesTools, groupMessages } from "./messageUtils"

describe("filterVisibleMessages approval history", () => {
    it("keeps a rejected tool ask visible after the active interaction is cleared", () => {
        const rejectedTool: UiMessage = {
            ts: 100,
            type: "ask",
            ask: "tool",
            text: JSON.stringify({ tool: "editedExistingFile", path: "src/example.ts", content: "patch" }),
        }

        expect(filterVisibleMessages([rejectedTool])).toEqual([rejectedTool])
    })

    it("keeps a rejected low-stakes tool in the grouped timeline after a completed API request", () => {
        const completedApiRequest: UiMessage = {
            ts: 100,
            type: "say",
            say: "api_req_started",
            text: JSON.stringify({ cost: 0.01 }),
        }
        const rejectedTool: UiMessage = {
            ts: 101,
            type: "ask",
            ask: "tool",
            text: JSON.stringify({ tool: "readFile", path: "src/example.ts" }),
        }
        const messages = [completedApiRequest, rejectedTool]
        const grouped = groupLowStakesTools(groupMessages(filterVisibleMessages(messages)))
        const toolGroup = grouped.find(Array.isArray)

        expect(toolGroup).toBeDefined()
        expect(getToolsNotInCurrentActivities(toolGroup ?? [], messages)).toContain(rejectedTool)
    })
})
