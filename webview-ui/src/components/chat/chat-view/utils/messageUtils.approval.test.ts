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

    // A low-stakes call that waits on, or was refused at, approval is one call:
    // it is drawn once, as its approval card, and not also as a group entry.
    it("draws a final low-stakes approval exactly once, as its own row", () => {
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
        const pendingRead: UiMessage = {
            ts: 102,
            type: "ask",
            ask: "tool",
            text: JSON.stringify({ tool: "readFile", path: "/outside/secret.ts" }),
        }

        const grouped = groupChatRows([completedApiRequest, completedRead, pendingRead])
        const occurrences = grouped.flatMap((item) => (Array.isArray(item) ? item : [item])).filter((m) => m === pendingRead)

        expect(occurrences).toHaveLength(1)
        expect(grouped.at(-1)).toBe(pendingRead)
        expect(grouped.filter(Array.isArray).flat()).toContain(completedRead)
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
