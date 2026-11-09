import type { TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { withoutFooterOwnedApproval } from "./footerOwnedApproval"

/**
 * The tail of a real task after its second turn: the follow-up, the round-start
 * restore point, the request, and the completion the footer is showing.
 */
const followupTurn = (base: number): UiMessage[] => [
    { ts: base, type: "say", say: "user_feedback", text: "Continue" },
    { ts: base + 1, type: "say", say: "checkpoint_created" },
    { ts: base + 2, type: "say", say: "api_req_started" },
    { ts: base + 3, type: "ask", ask: "completion_result", text: "Done." },
]

/** A completed approval the footer hosts as its card. */
const hostedToolApproval = (base: number): UiMessage[] => [
    { ts: base, type: "say", say: "user_feedback", text: "Edit it" },
    { ts: base + 1, type: "ask", ask: "tool", text: JSON.stringify({ tool: "editedExistingFile", path: "a.txt" }) },
]

const view = (anchorTs: number, presentationKind: string): TaskViewState =>
    ({
        activeInteraction: { askMessageTs: anchorTs, presentationKind, taskAsk: "tool" },
    }) as unknown as TaskViewState

describe("the footer hosts only the call it is actually asking about", () => {
    it("leaves a completion result in the list when the footer hosts a tool approval", () => {
        const base = 1_000
        const messages = followupTurn(base)
        const asked = hostedToolApproval(base + 10)
        const all = [...messages, ...asked]

        const remaining = withoutFooterOwnedApproval(all, all, view(base + 11, "tool_approval"))

        // The footer really does host the approval, so this exercises the removal
        // branch: it leaves the list while the completion that ends the earlier
        // turn stays drawn — a turn without its ending cannot fold.
        expect(remaining.map(({ ts }) => ts)).not.toContain(base + 11)
        expect(remaining.map(({ ts }) => ts)).toContain(base + 3)
    })
})
