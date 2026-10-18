import type { TaskViewState, UiAsk, UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { withoutFooterOwnedApproval } from "./footerOwnedApproval"

const request: UiMessage = { ts: 1, type: "say", say: "api_req_started", text: "{}" }

function ask(ts: number, kind: UiAsk, text: string): UiMessage {
    return { ts, type: "ask", ask: kind, interactionId: `interaction-${ts}`, text }
}

function awaiting(message: UiMessage, presentationKind: string): TaskViewState {
    return {
        activeInteraction: {
            interactionId: message.interactionId,
            taskAsk: message.ask,
            presentationKind,
            askMessageTs: message.ts,
            status: "awaiting",
        },
    } as TaskViewState
}

const hostedApprovals: [string, UiMessage][] = [
    ["tool_approval", ask(2, "tool", JSON.stringify({ tool: "listFilesTopLevel", path: "src" }))],
    ["tool_approval", ask(2, "tool", JSON.stringify({ tool: "editedExistingFile", path: "src/a.ts", diff: "-a\n+b" }))],
    ["command_approval", ask(2, "command", "npm test")],
    ["mcp_approval", ask(2, "use_mcp_server", JSON.stringify({ serverName: "otel", toolName: "query" }))],
    ["browser_approval", ask(2, "browser_action_launch", "https://example.com")],
    ["subagent_approval", ask(2, "use_subagents", JSON.stringify({ prompts: ["scan"] }))],
    ["spawn_task_approval", ask(2, "spawn_task", JSON.stringify({ task: "follow up" }))],
]

describe("withoutFooterOwnedApproval", () => {
    it.each(hostedApprovals)("leaves a pending %s call out of the chat for the footer to draw", (kind, pending) => {
        const messages = [request, pending]

        expect(withoutFooterOwnedApproval(messages, messages, awaiting(pending, kind))).toEqual([request])
    })

    it("lets the chat draw the call once the approval is answered", () => {
        const answered = hostedApprovals[0][1]
        const messages = [request, answered]

        expect(withoutFooterOwnedApproval(messages, messages, { activeInteraction: undefined } as TaskViewState)).toBe(messages)
    })

    it("keeps an ask the active interaction does not name", () => {
        const pending = hostedApprovals[2][1]
        const messages = [request, pending]

        expect(withoutFooterOwnedApproval(messages, messages, awaiting({ ...pending, ts: 9 }, "command_approval"))).toBe(messages)
    })

    it("keeps a focus-chain change, which the footer does not draw as a card", () => {
        const change = ask(2, "change_todo_list", JSON.stringify({ plan: "- [ ] a", reason: "r" }))
        const messages = [request, change]

        expect(withoutFooterOwnedApproval(messages, messages, awaiting(change, "focus_chain_change"))).toBe(messages)
    })

    it("keeps the row when the footer cannot resolve a single anchor from the full list", () => {
        const pending = hostedApprovals[2][1]
        const visible = [request, pending]

        // A duplicate anchor leaves the footer without a card, so the chat keeps drawing it.
        expect(withoutFooterOwnedApproval(visible, [...visible, { ...pending }], awaiting(pending, "command_approval"))).toBe(
            visible,
        )
    })
})
