// @vitest-environment jsdom
import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import ChatRow from "../ChatRow"

void React

const useSize = vi.hoisted(() => vi.fn((element: React.ReactElement) => [element, { width: 600, height: 900 }]))

vi.mock("react-use", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-use")>()
    return { ...actual, useSize }
})

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

function reportMessage(content: string): UiMessage {
    return {
        ts: 900,
        type: "ask",
        ask: "generate_report",
        text: JSON.stringify({ title: "Investigation", content }),
    }
}

const baseProps = {
    isExpanded: false,
    isLast: true,
    lastModifiedMessage: undefined,
    mode: "act" as const,
    onAddToInput: vi.fn(),
    onFollowupOptionSelect: vi.fn(async () => undefined),
    onSetQuote: vi.fn(),
    onToggleExpand: vi.fn(),
}

describe("ChatRow report height ownership", () => {
    it("leaves terminal-row height following to Virtuoso and bounds the nested report scroller", () => {
        const { rerender } = render(<ChatRow {...baseProps} message={reportMessage("one paragraph")} />)

        rerender(
            <ChatRow
                {...baseProps}
                message={reportMessage(Array.from({ length: 80 }, (_, index) => `paragraph ${index}`).join("\n\n"))}
            />,
        )

        expect(useSize).not.toHaveBeenCalled()
        const scroller = screen.getByTestId("generate-report-row").querySelector(".plan-completion-content")
        expect(scroller).toHaveClass("max-h-[50vh]", "overflow-y-auto", "overscroll-contain")
    })
})
