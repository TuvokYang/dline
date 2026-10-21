import type { TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { render } from "@testing-library/react"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

const DEEPSEEK_TOP_UP_URL = "https://platform.deepseek.com/top_up"

const mocks = vi.hoisted(() => ({
    extensionState: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.extensionState }))
vi.mock("@/context/ClineAuthContext", () => ({
    useClineAuth: () => ({ clineUser: undefined, activeOrganization: undefined }),
    useClineSignIn: () => ({ isLoginLoading: false, handleSignIn: vi.fn() }),
}))

const request: UiMessage = { type: "say", say: "api_req_started", text: "{}", ts: 10 }
// The ask text DeepSeekHandler.parseError serializes for an HTTP 402.
const balanceFailure = (ts: number): UiMessage => ({
    type: "ask",
    ask: "api_req_failed",
    text: JSON.stringify({
        message: "402 Insufficient Balance",
        status: 402,
        code: "insufficient_credits",
        providerId: "deepseek",
        details: { current_balance: 0 },
    }),
    ts,
})
const checkpoint = (ts: number): UiMessage => ({ type: "say", say: "checkpoint_created", ts })

function awaitingFailure(askMessageTs: number): TaskViewState {
    return {
        taskId: "task-1",
        phase: "paused",
        stateRevision: 2,
        activeInteraction: {
            taskId: "task-1",
            turnId: "turn-1",
            interactionId: "interaction-1",
            kind: "error_retry",
            status: "awaiting",
            stateRevision: 2,
            taskAsk: "api_req_failed",
            presentationKind: "api_req_failed",
            askMessageTs,
        },
        input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
        footer: { actions: [] },
    }
}

/** Render the failed request row the way the list does when a later row follows it. */
function renderRequestRow(messages: UiMessage[], askMessageTs: number) {
    mocks.extensionState = {
        mcpServers: [],
        mcpMarketplaceCatalog: { items: [] },
        onRelinquishControl: () => () => undefined,
        clineMessages: messages,
        showFeatureTips: false,
        taskViewState: awaitingFailure(askMessageTs),
    }
    return render(
        <ChatRowContent
            isExpanded={false}
            isLast={false}
            lastModifiedMessage={messages.at(-1)}
            message={request}
            onSetQuote={vi.fn()}
            onToggleExpand={vi.fn()}
        />,
    )
}

function topUpLink(container: HTMLElement): Element | null {
    return container.querySelector(`[href="${DEEPSEEK_TOP_UP_URL}"]`)
}

describe("ChatRow API failure ownership", () => {
    beforeEach(() => {
        mocks.extensionState = {}
    })

    it("shows the DeepSeek recharge card on the failed request when a round checkpoint renders after it", () => {
        const { container } = renderRequestRow([request, checkpoint(11), balanceFailure(12)], 12)

        expect(topUpLink(container)).not.toBeNull()
    })

    it("leaves Retry to the task footer, so the balance card offers only the top-up", () => {
        const { container } = renderRequestRow([request, balanceFailure(11)], 11)

        expect(topUpLink(container)).not.toBeNull()
        // The footer answers the failure interaction; the card may only link out of the task.
        const controlsBesideLinks = Array.from(container.querySelectorAll("vscode-button, button")).filter(
            (control) => !control.closest("a[href]"),
        )
        expect(controlsBesideLinks).toEqual([])
    })

    it("keeps the recharge card when the round checkpoint sorts after the failure ask", () => {
        const { container } = renderRequestRow([request, balanceFailure(11), checkpoint(12)], 11)

        expect(topUpLink(container)).not.toBeNull()
    })

    it("leaves the failure to an exhausted retry card instead of drawing it twice", () => {
        const exhausted: UiMessage = {
            type: "say",
            say: "error_retry",
            text: JSON.stringify({ attempt: 3, maxAttempts: 3, failed: true, errorMessage: "Insufficient Balance" }),
            ts: 11,
        }

        const { container } = renderRequestRow([request, exhausted, balanceFailure(12)], 12)

        expect(topUpLink(container)).toBeNull()
    })
})
