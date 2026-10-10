// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

vi.mock("@context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        backgroundEditEnabled: false,
        mcpServers: [],
        mcpMarketplaceCatalog: [],
        onRelinquishControl: () => () => undefined,
        vscodeTerminalExecutionMode: "backgroundExec",
        clineMessages: [],
        showFeatureTips: true,
        taskViewState: { taskId: "task-1", phase: "running" },
        currentTaskItem: { id: "task-1" },
    }),
}))

const baseProps = {
    isExpanded: false,
    isLast: true,
    onSetQuote: vi.fn(),
    onToggleExpand: vi.fn(),
}

function respondMessage(text: string, partial: boolean) {
    return {
        ts: 101,
        type: "say" as const,
        say: "tool" as const,
        partial,
        text: JSON.stringify({ tool: "actModeRespond", content: text }),
    }
}

describe("ChatRow act mode response lifecycle", () => {
    it("keeps the same progress-update renderer from partial through final", () => {
        const { rerender } = render(<ChatRowContent {...baseProps} message={respondMessage("Working", true)} />)
        const heading = screen.getByText("Progress Update", { exact: true })
        const card = heading.closest("div.rounded-sm")
        expect(card).not.toBeNull()
        expect(screen.getByText("Working", { exact: false })).toBeInTheDocument()

        rerender(<ChatRowContent {...baseProps} message={respondMessage("Work complete", false)} />)

        expect(screen.getByText("Progress Update", { exact: true }).closest("div.rounded-sm")).toBe(card)
        expect(screen.getByText("Work complete", { exact: false })).toBeInTheDocument()
    })
})
