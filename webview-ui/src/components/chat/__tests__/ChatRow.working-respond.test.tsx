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

/** A working_respond row as persisted; the row key predates the tool's rename. */
function respondMessage(text: string, partial: boolean) {
    return {
        ts: 101,
        type: "say" as const,
        say: "tool" as const,
        partial,
        text: JSON.stringify({ tool: "actModeRespond", content: text }),
    }
}

/** A phase_report row as persisted; the row key predates the tool's rename. */
function phaseReportMessage(text: string) {
    return {
        ts: 102,
        type: "say" as const,
        say: "tool" as const,
        partial: false,
        text: JSON.stringify({ tool: "statusUpdate", content: text }),
    }
}

describe("ChatRow working_respond lifecycle", () => {
    it("keeps the same reply renderer from partial through final", () => {
        const { rerender } = render(<ChatRowContent {...baseProps} message={respondMessage("Working", true)} />)
        const card = screen.getByTestId("working-respond-row")

        rerender(<ChatRowContent {...baseProps} message={respondMessage("Work complete", false)} />)

        expect(screen.getByTestId("working-respond-row")).toBe(card)
    })
})

describe("ChatRow update rows", () => {
    it("labels a phase report apart from a reply", () => {
        render(<ChatRowContent {...baseProps} message={phaseReportMessage("Phase one done")} />)

        const row = screen.getByTestId("phase-report-row")
        expect(screen.queryByTestId("working-respond-row")).toBeNull()
        expect(screen.queryByText("Reply", { exact: true })).toBeNull()
    })

    it("renders an acknowledgment request persisted by an earlier version as a plain phase report", () => {
        const legacyAsk = { ts: 103, type: "ask" as const, ask: "status_acknowledgment" as const, text: "Please confirm" }

        render(<ChatRowContent {...baseProps} message={legacyAsk} />)

        const row = screen.getByTestId("phase-report-row")
        expect(screen.queryByRole("button", { name: /acknowledge/i })).toBeNull()
    })
})
