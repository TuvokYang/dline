import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
    filterVisibleMessages,
    getToolsNotInCurrentActivities,
    groupChatRows,
    groupLowStakesTools,
    groupMessages,
} from "./messageUtils"

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

    // The footer draws a pending low-stakes call; once answered it lands in its
    // round's group like any call, not as a separate approval card at the end.
    it("draws an answered final low-stakes call exactly once, inside its round's group", () => {
        const completedApiRequest: UiMessage = {
            ts: 100,
            type: "say",
            say: "api_req_started",
            text: JSON.stringify({ cost: 0.01 }),
        }
        const completedRead: UiMessage = {
            ts: 101,
            type: "say",
            say: "tool",
            text: JSON.stringify({ tool: "readFile", path: "src/done.ts" }),
        }
        const answeredRead: UiMessage = {
            ts: 102,
            type: "ask",
            ask: "tool",
            text: JSON.stringify({ tool: "readFile", path: "/outside/secret.ts" }),
        }

        const grouped = groupChatRows([completedApiRequest, completedRead, answeredRead])
        const occurrences = grouped.flatMap((item) => (Array.isArray(item) ? item : [item])).filter((m) => m === answeredRead)
        const lastRow = grouped.at(-1)

        expect(occurrences).toHaveLength(1)
        expect(Array.isArray(lastRow)).toBe(true)
        expect(lastRow).toEqual(expect.arrayContaining([completedRead, answeredRead]))
    })

    it("keeps an earlier rejected low-stakes tool in the grouped timeline after a completed API request", () => {
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
        const laterRead: UiMessage = {
            ts: 102,
            type: "say",
            say: "tool",
            text: JSON.stringify({ tool: "readFile", path: "src/other.ts" }),
        }
        const messages = [completedApiRequest, rejectedTool, laterRead]
        const grouped = groupLowStakesTools(groupMessages(filterVisibleMessages(messages)))
        const toolGroup = grouped.find(Array.isArray)

        expect(toolGroup).toBeDefined()
        expect(getToolsNotInCurrentActivities(toolGroup ?? [], messages)).toContain(rejectedTool)
    })
})
