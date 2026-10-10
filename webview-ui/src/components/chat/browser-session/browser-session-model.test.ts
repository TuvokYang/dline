import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { projectBrowserSession } from "./browser-session-model"

describe("projectBrowserSession", () => {
    it("keeps browser actions in pages and projects ordinary messages outside the frame once", () => {
        const messages: UiMessage[] = [
            { ts: 1, type: "say", say: "browser_action_launch", text: "https://example.com" },
            {
                ts: 2,
                type: "say",
                say: "browser_action_result",
                text: JSON.stringify({ currentUrl: "https://example.com", screenshot: "first" }),
            },
            { ts: 3, type: "say", say: "reasoning", text: "reasoning" },
            { ts: 4, type: "say", say: "text", text: "response" },
            { ts: 5, type: "say", say: "browser_action", text: JSON.stringify({ action: "scroll_down" }) },
            {
                ts: 6,
                type: "say",
                say: "browser_action_result",
                text: JSON.stringify({ currentUrl: "https://example.com/down", screenshot: "second" }),
            },
        ]

        const projection = projectBrowserSession(messages)

        expect(projection.pages).toHaveLength(2)
        expect(projection.pages[1]?.actions).toEqual([{ messageTs: 5, action: "scroll_down" }])
        expect(projection.conversationMessages.map((message) => message.ts)).toEqual([3, 4])
    })

    it("projects approval launches, empty launch results, click, type, and close without inventing conversation rows", () => {
        const projection = projectBrowserSession([
            { ts: 1, type: "ask", ask: "browser_action_launch", text: "https://example.com" },
            { ts: 2, type: "say", say: "browser_action_result", text: "" },
            { ts: 3, type: "say", say: "browser_action", text: JSON.stringify({ action: "click", coordinate: "20,30" }) },
            { ts: 4, type: "say", say: "browser_action", text: JSON.stringify({ action: "type", text: "hello" }) },
            {
                ts: 5,
                type: "say",
                say: "browser_action_result",
                text: JSON.stringify({ currentUrl: "https://example.com/form", screenshot: "form" }),
            },
            { ts: 6, type: "say", say: "browser_action", text: JSON.stringify({ action: "close" }) },
        ])

        expect(projection.initialUrl).toBe("https://example.com")
        expect(projection.isAutoApproved).toBe(false)
        expect(projection.hasBrowserResult).toBe(true)
        expect(projection.pages).toEqual([
            {
                state: { url: "https://example.com/form", screenshot: "form" },
                actions: [
                    { messageTs: 3, action: "click", coordinate: "20,30" },
                    { messageTs: 4, action: "type", text: "hello" },
                ],
            },
            { state: {}, actions: [{ messageTs: 6, action: "close" }] },
        ])
        expect(projection.conversationMessages).toEqual([])
    })

    it("degrades malformed browser payloads without moving them into conversation content", () => {
        const projection = projectBrowserSession([
            { ts: 1, type: "say", say: "browser_action_launch", text: "https://example.com" },
            { ts: 2, type: "say", say: "browser_action", text: "{" },
            { ts: 3, type: "say", say: "browser_action_result", text: "not-json" },
        ])

        expect(projection.pages).toEqual([{ state: {}, actions: [] }])
        expect(projection.conversationMessages).toEqual([])
    })
})
