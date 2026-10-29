// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

let taskPhase = "completed"

vi.mock("@context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        backgroundEditEnabled: false,
        mcpServers: [],
        mcpMarketplaceCatalog: [],
        onRelinquishControl: () => () => undefined,
        vscodeTerminalExecutionMode: "backgroundExec",
        clineMessages: [],
        showFeatureTips: true,
        taskViewState: { taskId: "task-1", phase: taskPhase },
        currentTaskItem: { id: "task-1" },
    }),
}))

vi.mock("../FeatureTip", () => ({
    default: () => <div data-testid="feature-tip">Feature tip</div>,
}))

const baseProps = {
    isExpanded: false,
    isLast: true,
    onSetQuote: vi.fn(),
    onToggleExpand: vi.fn(),
}

describe("ChatRow completed reasoning", () => {
    beforeEach(() => {
        taskPhase = "completed"
    })

    it("treats a stale partial reasoning message as static after the canonical task phase completes", () => {
        render(
            <ChatRowContent
                {...baseProps}
                message={{
                    ts: 1,
                    type: "say",
                    say: "reasoning",
                    partial: true,
                    text: "Completed reasoning",
                }}
            />,
        )

        expect(screen.getByRole("button", { name: /Thinking/i })).toBeInTheDocument()
        expect(screen.getByText("Thinking", { exact: true })).toBeInTheDocument()
        expect(screen.queryByText("Thinking...", { exact: true })).not.toBeInTheDocument()
        expect(screen.queryByText("Waiting...", { exact: true })).not.toBeInTheDocument()
        expect(screen.queryByTestId("feature-tip")).not.toBeInTheDocument()
    })

    it("collapses partial reasoning after a following response or tool row owns the tail", () => {
        taskPhase = "streaming"
        render(
            <ChatRowContent
                {...baseProps}
                isLast={false}
                message={{
                    ts: 1,
                    type: "say",
                    say: "reasoning",
                    partial: true,
                    text: "Reasoning before the turn-ending tool",
                }}
            />,
        )

        expect(screen.getByText("Thinking", { exact: true })).toBeInTheDocument()
        expect(screen.queryByText("Thinking...", { exact: true })).not.toBeInTheDocument()
        expect(screen.queryByText("Reasoning before the turn-ending tool", { exact: true })).not.toBeInTheDocument()
        expect(screen.queryByTestId("feature-tip")).not.toBeInTheDocument()
    })
})
