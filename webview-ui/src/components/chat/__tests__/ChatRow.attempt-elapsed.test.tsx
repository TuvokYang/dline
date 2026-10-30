import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

const state = vi.hoisted(() => ({ clineMessages: [] as UiMessage[] }))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        backgroundEditEnabled: false,
        mcpServers: [],
        mcpMarketplaceCatalog: [],
        onRelinquishControl: () => () => undefined,
        vscodeTerminalExecutionMode: "backgroundExec",
        clineMessages: state.clineMessages,
        showFeatureTips: false,
        taskViewState: undefined,
        currentTaskItem: { id: "task-1" },
    }),
}))

const baseProps = {
    isExpanded: false,
    isLast: true,
    onSetQuote: vi.fn(),
    onToggleExpand: vi.fn(),
}

const SECOND = 1_000

function completion(ts: number): UiMessage {
    return { type: "say", say: "completion_result", text: "Done", ts }
}

function renderCompletion(ts: number) {
    return render(<ChatRowContent {...baseProps} message={completion(ts)} />)
}

beforeEach(() => {
    state.clineMessages = []
})

describe("attempt elapsed in the completion title", () => {
    it("shows how long the attempt waited after the user input that started it", () => {
        state.clineMessages = [{ type: "say", say: "task", text: "Do the work", ts: 1_000 }, completion(1_000 + 95 * SECOND)]

        renderCompletion(1_000 + 95 * SECOND)

        expect(screen.getByTestId("completion-output-elapsed").textContent).toBe("1m 35s")
    })

    it("measures from a follow-up input rather than the original prompt", () => {
        state.clineMessages = [
            { type: "say", say: "task", text: "Do the work", ts: 1_000 },
            completion(1_000 + 200 * SECOND),
            { type: "say", say: "user_feedback", text: "Also this", ts: 400 * SECOND },
            completion(400 * SECOND + 12 * SECOND),
        ]

        renderCompletion(400 * SECOND + 12 * SECOND)

        expect(screen.getByTestId("completion-output-elapsed").textContent).toBe("12s")
    })

    it("omits the figure when no user input precedes the attempt", () => {
        state.clineMessages = [completion(5 * SECOND)]

        renderCompletion(5 * SECOND)

        expect(screen.queryByTestId("completion-output-elapsed")).toBeNull()
        expect(screen.getByText("Task Completed")).toBeInTheDocument()
    })
})
